/**
 * Conservative, JSON-Schema-driven coercion for MCP tool inputs.
 *
 * LLMs frequently emit numeric/boolean arguments as strings (e.g. `year: "2026"`
 * instead of `year: 2026`) in the XML/JSON tool-call format. MCP servers whose
 * tools declare `{"type": "integer"}` / `{"type": "number"}` / `{"type":
 * "boolean"}` then reject the call with `invalid_type: expected number, received
 * string`. The non-coercing Zod schema we build from the same JSON Schema fails
 * identically before the request even leaves the client.
 *
 * {@link coerceInputToJsonSchema} walks the tool's original JSON Schema and
 * coerces a value ONLY when the schema unambiguously demands it:
 *  - string -> number/integer/boolean where the schema declares that type;
 *  - a single-element array -> its object element where the schema expects an
 *    object and never permits an array (the `lp_update: [{...}]` bug), including
 *    a defense-in-depth case for a genuinely uninformative (`{}`) node such as
 *    a Pydantic `Any` field (the `synthesis: [{...}]` subagent bug);
 *  - a bare scalar/object -> a single-element array where the schema expects an
 *    array and does not otherwise accept the value directly (the
 *    `body_categories: "foo"` bug), parsing a bracketed JSON-array string first.
 * Anything else is returned untouched so genuinely-invalid input (e.g. a
 * non-numeric string for a number field) is still rejected by validation.
 */

type JsonSchema = Record<string, unknown>

const MAX_DEPTH = 50

/**
 * Coerce `value` against the given JSON Schema, returning a new value with
 * string-encoded numbers/booleans converted where the schema demands it.
 *
 * Safe to call with any value/schema shape: unknown or malformed schema nodes
 * result in the value being returned unchanged.
 */
export function coerceInputToJsonSchema(
  value: unknown,
  schema: unknown,
): unknown {
  const root = isObject(schema) ? schema : undefined
  // `refPath` is a PER-DESCENT-PATH guard against $ref cycles. We copy it when
  // recursing (not mutate a shared set), so the same $ref reused across sibling
  // properties still coerces each one — only a ref that recurses into ITSELF is
  // blocked.
  return coerce(value, schema, root, new Set<string>(), 0, true)
}

function coerce(
  value: unknown,
  schema: unknown,
  root: JsonSchema | undefined,
  refPath: Set<string>,
  depth: number,
  // Whether a single-element-array->object unwrap may run at this node. It's
  // suppressed when recursing INTO a composite (anyOf/oneOf/allOf) branch: the
  // decision to unwrap must be made against the whole composite node (which may
  // permit an array in a sibling branch), never against one branch in
  // isolation. Otherwise an object-or-array union would wrongly unwrap when the
  // object branch is evaluated alone.
  mayUnwrap: boolean,
): unknown {
  if (depth > MAX_DEPTH) return value
  if (!isObject(schema)) return value

  // Resolve a $ref (cycle-guarded) before inspecting the node.
  const resolved = resolveRef(schema, root, refPath)
  if (!resolved) return value
  const node = resolved.schema
  // When we followed a $ref, descend with the ref recorded on this path so a
  // self-referential ref terminates, while sibling reuse (a fresh copy per
  // call) is unaffected.
  const childRefPath = resolved.ref
    ? new Set(refPath).add(resolved.ref)
    : refPath

  // Unwrap a single-element array into its object element when the schema
  // unambiguously expects an object (and does NOT permit an array). LLMs
  // sometimes emit a nested object param wrapped in a one-element array (e.g.
  // `lp_update: [{...}]` instead of `lp_update: {...}`), which servers reject
  // with `Must be an object, not an array`. This is the object-shaped mirror of
  // the string->number coercion below: normalize only where the schema demands
  // it. Empty and multi-element arrays are left untouched (ambiguous). If the
  // schema accepts an array in any branch, we respect the array and never
  // unwrap. The unwrapped object then falls through to the normal
  // object/anyOf coercion so its inner fields (e.g. `year`) are still coerced.
  if (
    mayUnwrap &&
    Array.isArray(value) &&
    value.length === 1 &&
    isObject(value[0]) &&
    schemaExpectsObject(node, root, childRefPath) &&
    !schemaExpectsArray(node, root, childRefPath)
  ) {
    value = value[0]
  } else if (
    // Defense-in-depth for the object-unwrap when the schema node is genuinely
    // UNINFORMATIVE (`{}`) — e.g. a Pydantic `Any` / freeform-JSON field, or a
    // param whose schema arrived stripped. The check above can't fire there
    // (`schemaExpectsObject` needs a `type`/`properties` to key off), yet the
    // LLM still sometimes wraps the object in a one-element array
    // (`synthesis: [{...}]`), which the server rejects with `Must be an object,
    // not an array`. Unwrap it — but ONLY when the node tells us NOTHING that
    // would permit an array. `schemaExpectsArray` is the absolute guard: if an
    // array is possible anywhere (direct or via a branch), we never unwrap. We
    // also require the node to be truly empty of shape (no type/items/enum/
    // properties/additionalProperties/composite), so a node that merely omits
    // `properties` but declares, say, `type:'string'` is left alone.
    mayUnwrap &&
    Array.isArray(value) &&
    value.length === 1 &&
    isObject(value[0]) &&
    isUninformativeSchema(node) &&
    !schemaExpectsArray(node, root, childRefPath)
  ) {
    value = value[0]
  }

  // Symmetric to the object-unwrap above: WRAP a bare scalar/object into a
  // single-element array when the schema unambiguously expects an array and does
  // NOT otherwise accept the value directly (e.g. the LLM emits
  // `body_categories: "foo"` for a `string[]` param, which servers reject with
  // `expected array, received string`). A bracketed JSON-array string
  // (`'["a","b"]'`) is parsed first; otherwise the value is wrapped as `[value]`.
  // The wrapped value falls through to the normal array dispatch so its items
  // are coerced against `items` (e.g. `["2026"]` for an integer array -> `[2026]`).
  // Like unwrap, this is suppressed inside composite branches (`mayUnwrap`): the
  // decision must be made against the whole composite node so a scalar that a
  // sibling branch accepts (e.g. `int | int[]` with `"5"`) is not wrapped.
  if (
    mayUnwrap &&
    !Array.isArray(value) &&
    value != null &&
    schemaExpectsArray(node, root, childRefPath) &&
    !schemaAcceptsValueDirectly(value, node, root, childRefPath)
  ) {
    value = maybeParseJsonArray(value) ?? [value]
  }

  // Composite schemas: try each branch and take the first that changes the
  // value (i.e. produced a successful coercion). If none change it, return as-is.
  // Unwrap is suppressed inside branches (see `mayUnwrap`): it was already
  // decided above against the whole composite node.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const next = coerce(value, branch, root, childRefPath, depth + 1, false)
        if (next !== value) return next
      }
    }
  }

  const type = getSchemaType(node)

  if (type === 'object' || (isObject(value) && hasProperties(node))) {
    return coerceObject(value, node, root, childRefPath, depth)
  }

  if (type === 'array' || (Array.isArray(value) && 'items' in node)) {
    return coerceArray(value, node, root, childRefPath, depth)
  }

  if (type === 'integer' || type === 'number') {
    return coerceNumber(value, type)
  }

  if (type === 'boolean') {
    return coerceBoolean(value)
  }

  return value
}

/**
 * Whether a schema node is genuinely uninformative — it declares NOTHING that
 * describes its value's shape: no `type`, no `properties`, no
 * `additionalProperties` schema, no `items`, no `enum`/`const`, and no
 * `anyOf`/`oneOf`/`allOf` composite. This is the shape of a Pydantic `Any`
 * field (`{}`) or a param whose schema arrived stripped. Used to gate the
 * defense-in-depth array->object unwrap: we only unwrap a blind `[{...}]` when
 * the node tells us nothing that would permit an array (combined with the
 * absolute `!schemaExpectsArray` guard at the call site).
 */
function isUninformativeSchema(node: JsonSchema): boolean {
  const shapeKeys = [
    'type',
    'properties',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    'oneOf',
    'allOf',
    '$ref',
  ]
  return !shapeKeys.some((key) => key in node)
}

/**
 * Shallow check for whether a schema node can accept an object value — either
 * directly (`type: 'object'` / has `properties`) or via any `anyOf`/`oneOf`/
 * `allOf` branch (resolving each branch's `$ref`, cycle-guarded).
 */
function schemaExpectsObject(
  node: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
): boolean {
  if (getSchemaType(node) === 'object' || hasProperties(node)) return true
  return anyBranch(node, root, refPath, (branch) => {
    return getSchemaType(branch) === 'object' || hasProperties(branch)
  })
}

/**
 * Shallow check for whether a schema node can accept an array value — either
 * directly (`type: 'array'` / has `items`) or via any composite branch. Used to
 * make the array->object unwrap conservative: if a schema permits an array
 * anywhere, we must not unwrap.
 */
function schemaExpectsArray(
  node: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
): boolean {
  if (getSchemaType(node) === 'array' || 'items' in node) return true
  return anyBranch(node, root, refPath, (branch) => {
    return getSchemaType(branch) === 'array' || 'items' in branch
  })
}

/**
 * Runs `predicate` against each resolved `anyOf`/`oneOf`/`allOf` branch of
 * `node`, returning true if any branch matches. Branch `$ref`s are resolved
 * (cycle-guarded) so composite Pydantic schemas are inspected correctly.
 */
function anyBranch(
  node: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
  predicate: (branch: JsonSchema) => boolean,
): boolean {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      if (!isObject(branch)) continue
      const resolved = resolveRef(branch, root, refPath)
      if (resolved && predicate(resolved.schema)) return true
    }
  }
  return false
}

/**
 * Whether the schema (or any composite branch) directly accepts `value`'s own
 * JSON type — the ambiguity gate for the array-wrap. If a schema accepts the
 * bare value as-is, we must NOT wrap it into an array. This also lets a scalar
 * that WOULD coerce into a value an array-union sibling accepts (e.g. `"5"` for
 * `int | int[]`) resolve to the scalar via the composite loop instead of `[5]`.
 */
function schemaAcceptsValueDirectly(
  value: unknown,
  node: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
): boolean {
  const jsType = jsonTypeOfValue(value)
  const accepts = (schema: JsonSchema): boolean => {
    const types = getSchemaTypeSet(schema)
    if (types.has(jsType)) return true
    if (jsType === 'object' && hasProperties(schema)) return true
    if (jsType === 'array' && 'items' in schema) return true
    // An integer JS value also satisfies a `number` schema.
    if (jsType === 'integer' && types.has('number')) return true
    // A string that WOULD coerce into a scalar the schema accepts: let the
    // scalar interpretation win (via the composite loop) rather than wrapping.
    if (typeof value === 'string') {
      if (
        (types.has('integer') || types.has('number')) &&
        coerceNumber(value, types.has('integer') ? 'integer' : 'number') !==
          value
      ) {
        return true
      }
      if (types.has('boolean') && coerceBoolean(value) !== value) return true
    }
    return false
  }
  if (accepts(node)) return true
  return anyBranch(node, root, refPath, accepts)
}

/** Maps a JS value to the JSON Schema type name it satisfies. */
function jsonTypeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number'
    case 'object':
      return 'object'
    default:
      return 'unknown'
  }
}

/**
 * Like {@link getSchemaType} but returns the FULL set of declared types (so a
 * union like `["integer", "null"]` reports both). Used by the array-wrap
 * ambiguity gate, which must consider every declared type, not just the first.
 */
function getSchemaTypeSet(schema: JsonSchema): Set<string> {
  const type = schema.type
  if (typeof type === 'string') return new Set([type])
  if (Array.isArray(type)) {
    return new Set(type.filter((t): t is string => typeof t === 'string'))
  }
  return new Set()
}

/**
 * If `value` is a string that looks like a JSON array (`[...]`), parse it and
 * return the array; otherwise undefined. Bracket-guarded so bare scalars like
 * `"123"` or `"foo"` are never parsed (they fall through to a plain wrap).
 */
function maybeParseJsonArray(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function coerceObject(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
  depth: number,
): unknown {
  if (!isObject(value)) return value
  const properties = schema.properties
  if (!isObject(properties)) return value

  const result: Record<string, unknown> = { ...value }
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in result) {
      // Each sibling property gets a copy of the current ref path, so reusing
      // the same $ref across properties coerces every one of them. Each property
      // is a fresh node, so unwrap is allowed here.
      result[key] = coerce(
        result[key],
        propSchema,
        root,
        new Set(refPath),
        depth + 1,
        true,
      )
    }
  }
  return result
}

function coerceArray(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
  depth: number,
): unknown {
  if (!Array.isArray(value)) return value
  const items = schema.items
  if (!isObject(items)) return value
  return value.map((item) =>
    coerce(item, items, root, new Set(refPath), depth + 1, true),
  )
}

function coerceNumber(value: unknown, type: 'integer' | 'number'): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return value
  const num = Number(trimmed)
  if (!Number.isFinite(num)) return value
  // For integer fields, only coerce whole numbers so we don't silently drop a
  // fractional part the server would otherwise reject.
  if (type === 'integer' && !Number.isInteger(num)) return value
  return num
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const lower = value.trim().toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return value
}

/**
 * Resolves a JSON Schema `$ref` (e.g. `#/$defs/Foo` or `#/definitions/Foo`)
 * against the root schema.
 *
 * Returns:
 *  - `{ schema, ref }` with the resolved target and the ref string (so the
 *    caller can record it on the current path) when `schema` is a `$ref`.
 *  - `{ schema, ref: undefined }` unchanged when `schema` is not a `$ref`.
 *  - `undefined` when the ref can't be resolved or would form a cycle on the
 *    current descent path.
 */
function resolveRef(
  schema: JsonSchema,
  root: JsonSchema | undefined,
  refPath: Set<string>,
): { schema: JsonSchema; ref: string | undefined } | undefined {
  const ref = schema.$ref
  if (typeof ref !== 'string') return { schema, ref: undefined }
  if (!root) return undefined
  // Cycle guard: this ref is already on the current descent path.
  if (refPath.has(ref)) return undefined

  // Only local refs (starting with '#/') are supported.
  if (!ref.startsWith('#/')) return undefined
  const path = ref.slice(2).split('/')
  let current: unknown = root
  for (const segment of path) {
    if (!isObject(current)) return undefined
    // JSON Pointer unescaping (~1 -> '/', ~0 -> '~').
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    current = current[key]
  }
  return isObject(current) ? { schema: current, ref } : undefined
}

function getSchemaType(schema: JsonSchema): string | undefined {
  const type = schema.type
  if (typeof type === 'string') return type
  // A union type like ["number", "null"]: report the first non-null primitive.
  if (Array.isArray(type)) {
    const primitive = type.find((t) => typeof t === 'string' && t !== 'null')
    return typeof primitive === 'string' ? primitive : undefined
  }
  return undefined
}

function hasProperties(schema: JsonSchema): boolean {
  return isObject(schema.properties)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
