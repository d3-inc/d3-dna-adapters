-- dna.lua: the DNA wire contract for OpenResty, ported from
-- @d3-inc/d3-dna-protocol. The phase scripts beside it load it, and
-- test/unit.lua checks each function against the package's own answers
-- (test/parity.json), so the TS function named above each one is the spec.
-- Every library loads here, so a missing one fails the load, which fails open with its name logged.
local cjson    = require "cjson.safe"
local lrucache = require "resty.lrucache"
local sha256   = require "resty.sha256"
local http     = require "resty.http"

local M = {}

-- An instance of our own, so the site's other Lua keeps cjson's defaults.
local json = cjson.new()
json.decode_array_with_array_mt(true)
local NULL, ARRAY_MT = json.null, json.array_mt
M.null = NULL

-- Revisions (extract.ts ADAPTER_SET, forwarding.constants.ts).
M.ADAPTER_SET            = 3
M.FORWARDED_HEADER_SET   = 2
local FORWARDS_ALL_SINCE = 2
local CARRIES_MCP_SINCE  = 3

local FORWARDED_MAX_COOKIES      = 256
local FORWARDED_MAX_NAMES        = 128
local FORWARDED_VALUE_MAX_LENGTH = 2048
local FORWARDED_MAX_TOTAL_LENGTH = 16384
local MAX_DEBUG_HEADERS          = 64
local MAX_DEBUG_HEADER_LENGTH    = 2048
M.MCP_BODY_MAX_BYTES             = 1048576
M.MCP_RESULT_MAX_BYTES           = 4 * 1048576
local MCP_METHOD_MAX_LENGTH      = 128
local MCP_NAME_MAX_LENGTH        = 256
local MCP_KEY_ARGUMENT_MEMORY_S  = 300
local MCP_KEY_ARGUMENT_MAX_HOSTS = 10000

M.DEFAULT_ENDPOINT           = "https://edge-api.d3.com/v1/decision"
M.DEFAULT_TIMEOUT_MS         = 150
M.DEFAULT_PAYMENT_TIMEOUT_MS = 10000

local PAY_SESSION_COOKIE  = "__Host-d3pay"
local PAY_SESSION_HEADER  = "d3pay-session"
local PERSON_PASS_COOKIE  = "__Host-d3person"
local PERSON_PASS_HEADER  = "d3pay-person"
local COOKIE_TOKEN_MAX    = 64
local PAY_HANDOFF_PARAM   = "d3pay_handoff"
local MCP_DNA_KEY_HEADER  = "mcp-param-dna-key"
local MCP_KEY_ARGUMENT    = "dna_account_key"
local MCP_X402_META       = "x402/payment"
local MCP_DNA_KEY_META    = "dna.d3.com/key"
local ACME_PREFIX         = "/.well-known/acme-challenge/"

M.FORWARDED_HEADERS = {
  "signature", "signature-input", "signature-agent", "user-agent", "content-digest", "accept",
  "sec-fetch-mode", "sec-fetch-dest", "upgrade-insecure-requests",
  "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile", "accept-language",
  "sec-purpose", "x-purpose", "purpose",
  "x-scitt-receipt", "x-ans-status-token", "dpop",
  "payment-signature", "x-payment", "payment-authorization",
}

M.HEADER_LENGTH_CAPS = {
  ["x-scitt-receipt"] = 1398104, ["x-ans-status-token"] = 1398104, ["dpop"] = 8192,
  ["accept"] = 256,
  ["sec-fetch-mode"] = 32, ["sec-fetch-dest"] = 32, ["upgrade-insecure-requests"] = 32,
  ["sec-ch-ua"] = 256, ["sec-ch-ua-platform"] = 256, ["sec-ch-ua-mobile"] = 256, ["accept-language"] = 256,
  ["payment-signature"] = 4096, ["x-payment"] = 4096, ["payment-authorization"] = 4096,
  [PAY_SESSION_HEADER] = COOKIE_TOKEN_MAX,
}

M.NEVER_FORWARDED_HEADERS = {
  "connection", "transfer-encoding", "content-length", "host", "authorization", "proxy-authorization",
  "cookie", MCP_DNA_KEY_HEADER, "x-vercel-oidc-token",
  "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret",
}

-- Presenting one of these under its cap is a payment, and buys the payment budget.
local PAYMENT_HEADER_CAPS = {
  ["payment-signature"] = 4096, ["x-payment"] = 4096, ["payment-authorization"] = 4096,
  [PAY_SESSION_HEADER] = COOKIE_TOKEN_MAX,
}

-- Never to the origin (payment-header.ts ORIGIN_STRIPPED_HEADERS).
M.ORIGIN_STRIPPED_HEADERS = {
  "payment-signature", "x-payment", "payment-authorization", PAY_SESSION_HEADER,
  PERSON_PASS_HEADER, MCP_DNA_KEY_HEADER,
}

M.MCP_KEY_ARGUMENT_SCHEMA = {
  type = "string",
  description = "A DNA account key that pays for this call. Leave it out to be told how to pay.",
  ["x-mcp-header"] = "Dna-Key",
}

local function set_of(list)
  local set = {}
  for _, v in ipairs(list) do set[v] = true end
  return set
end

local NEVER_FORWARDED = set_of(M.NEVER_FORWARDED_HEADERS)
local OWN_COOKIES     = set_of({ PAY_SESSION_COOKIE, PERSON_PASS_COOKIE })
local OWN_PARAMS      = set_of({ PAY_HANDOFF_PARAM, "d3pay_check", "d3pay_browser" })

local function array(t) return setmetatable(t or {}, ARRAY_MT) end
local function is_array(v) return type(v) == "table" and getmetatable(v) == ARRAY_MT end
local function is_record(v) return type(v) == "table" and getmetatable(v) ~= ARRAY_MT and v ~= NULL end
local function string_or_nil(v) if type(v) == "string" and #v > 0 then return v end end

-- By position, not a pattern: `^%s*(.-)%s*$` backtracks quadratically, and a
-- visitor's cookie name padded with spaces would stall the worker.
local function trim(s)
  local from = string.find(s, "%S")
  if from == nil then return "" end
  local to = #s
  while to > from and string.find(string.sub(s, to, to), "^%s$") do to = to - 1 end
  return string.sub(s, from, to)
end

M.trim = trim

local function copy(t)
  local out = {}
  for k, v in pairs(t) do out[k] = v end
  return setmetatable(out, getmetatable(t))
end

local function count_keys(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

-- string.gmatch skips the empty fields a split must keep.
local function split(s, sep)
  local out, from = {}, 1
  while true do
    local at = string.find(s, sep, from, true)
    if at == nil then
      out[#out + 1] = string.sub(s, from)
      return out
    end

    out[#out + 1] = string.sub(s, from, at - 1)
    from = at + #sep
  end
end

local function contains(list, value)
  for _, v in ipairs(list) do if v == value then return true end end
  return false
end

-- ── JSON out ─────────────────────────────────────────────────────────────────
-- cjson writes at most 16 significant digits, so 0.30000000000000004 would reach
-- the origin as 0.3. This writes the shortest form that reads back exactly.

local ESCAPES = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function encode_string(s)
  return '"' .. string.gsub(s, '[%z\1-\31"\\]', function(c)
    return ESCAPES[c] or string.format("\\u%04x", string.byte(c))
  end) .. '"'
end

local function encode_number(n)
  if n ~= n or n == math.huge or n == -math.huge then return "null" end
  if n == 0 then return "0" end
  if n == math.floor(n) and math.abs(n) < 1e21 then return string.format("%.0f", n) end
  for precision = 15, 17 do
    local s = string.format("%." .. precision .. "g", n)
    if tonumber(s) == n then return s end
  end
end

local encode

local function encode_value(v)
  local kind = type(v)
  if v == NULL or v == nil then return "null" end
  if kind == "string" then return encode_string(v) end
  if kind == "number" then return encode_number(v) end
  if kind == "boolean" then return v and "true" or "false" end
  if kind == "table" then return encode(v) end
  error("dna: cannot encode a " .. kind)
end

-- Keys sorted, so the same table always encodes to the same bytes.
encode = function(t)
  if is_array(t) then
    local parts = {}
    for i = 1, #t do parts[i] = encode_value(t[i]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end

  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = tostring(k) end
  table.sort(keys)
  local parts = {}
  for i, k in ipairs(keys) do parts[i] = encode_string(k) .. ":" .. encode_value(t[k]) end
  return "{" .. table.concat(parts, ",") .. "}"
end

M.json_encode = encode_value
M.is_record = is_record

-- A UTF-8 byte order mark, which TextDecoder drops before JSON.parse reads.
function M.json_decode(s)
  if string.sub(s, 1, 3) == "\239\187\191" then s = string.sub(s, 4) end
  return json.decode(s)
end

M.array = array

-- ── Settings (adapter-settings.ts) ───────────────────────────────────────────

M.SETTING_NAMES = {
  api_key            = { "DNA_API_KEY", "POLICY_ADAPTER_KEY", "POLICY_SHARED_SECRET" },
  endpoint           = { "DNA_ENDPOINT", "POLICY_WORKER_URL" },
  enabled            = { "DNA_ENABLED" },
  fail_mode          = { "DNA_FAIL_MODE", "FAIL_MODE" },
  timeout_ms         = { "DNA_TIMEOUT_MS", "POLICY_TIMEOUT_MS" },
  payment_timeout_ms = { "DNA_PAYMENT_TIMEOUT_MS", "POLICY_PAYMENT_TIMEOUT_MS" },
  debug              = { "DNA_DEBUG_LOG_RAW_PAYLOAD", "DEBUG_LOG_RAW_PAYLOAD" },
  exclude_headers    = { "DNA_EXCLUDE_HEADERS" },
  exclude_cookies    = { "DNA_EXCLUDE_COOKIES" },
}

local function first_setting(getenv, names, counts_empty)
  for _, name in ipairs(names) do
    local value = getenv(name)
    if value ~= nil and (counts_empty or value ~= "") then return name, value end
  end
end

local function positive_number(raw, fallback)
  local n = tonumber(raw)
  if n ~= nil and n == n and n > 0 and n < math.huge then return n end
  return fallback
end

-- parseExclusionList: names, trimmed, blanks and repeats dropped, never capped.
function M.parse_exclusion_list(raw, lowercase)
  local names, seen = array(), {}
  for _, part in ipairs(split(raw or "", ",")) do
    local name = trim(part)
    if lowercase then name = string.lower(name) end
    if #name > 0 and not seen[name] then
      seen[name] = true
      names[#names + 1] = name
    end
  end

  return names
end

-- dnaEndpoint: DNA_ENABLED=false, an empty endpoint, or no DNA_API_KEY is off.
function M.dna_endpoint(endpoint, has_dna_api_key, enabled)
  if enabled ~= nil and string.lower(trim(enabled)) == "false" then return nil end
  if endpoint ~= nil then
    if endpoint == "" then return nil end
    return endpoint
  end

  return has_dna_api_key and M.DEFAULT_ENDPOINT or nil
end

-- readAdapterSettings, but the unpaid budget defaults to 150 ms, not 2 s (ADR 0090).
function M.settings(getenv)
  local names = M.SETTING_NAMES
  local read = function(list) return select(2, first_setting(getenv, list, false)) end
  local _, endpoint = first_setting(getenv, names.endpoint, true)
  local key_name, api_key = first_setting(getenv, names.api_key, false)
  -- A host's own DEBUG_LOG_RAW_PAYLOAD would forward every header to us, so that
  -- generic name counts only on an install still using POLICY_WORKER_URL.
  local debug_names = getenv("POLICY_WORKER_URL") ~= nil and names.debug or { "DNA_DEBUG_LOG_RAW_PAYLOAD" }

  return {
    endpoint = M.dna_endpoint(endpoint, key_name == "DNA_API_KEY", read(names.enabled)),
    api_key = api_key,
    fail_mode = read(names.fail_mode) == "closed" and "closed" or "open",
    timeout_ms = positive_number(read(names.timeout_ms), M.DEFAULT_TIMEOUT_MS),
    payment_timeout_ms = positive_number(read(names.payment_timeout_ms), M.DEFAULT_PAYMENT_TIMEOUT_MS),
    debug_log_raw_payload = read(debug_names) == "true",
    exclude = {
      headers = M.parse_exclusion_list(read(names.exclude_headers), true),
      cookies = M.parse_exclusion_list(read(names.exclude_cookies), false),
    },
  }
end

local cached

-- The environment is fixed for a worker's life, so read it once per worker.
function M.cached_settings(getenv)
  if cached == nil then cached = M.settings(getenv) end
  return cached
end

-- ── Cookies and our URL params (pay-session.ts) ──────────────────────────────

local function cookie_name(pair)
  local eq = string.find(pair, "=", 1, true)
  return trim(eq and string.sub(pair, 1, eq - 1) or pair)
end

-- cookiesOf: every cookie as { name, value }, in order.
function M.cookies_of(header)
  local out = array()
  if header == nil or header == "" then return out end
  for _, pair in ipairs(split(header, ";")) do
    local eq = string.find(pair, "=", 1, true)
    if eq ~= nil then
      local name = cookie_name(pair)
      if name ~= "" then out[#out + 1] = { name, trim(string.sub(pair, eq + 1)) } end
    end
  end

  return out
end

function M.read_cookie(header, name)
  if header == nil or header == "" then return nil end
  for _, pair in ipairs(split(header, ";")) do
    local eq = string.find(pair, "=", 1, true)
    if eq ~= nil and cookie_name(pair) == name then return trim(string.sub(pair, eq + 1)) end
  end
end

-- stripOwnCookies: by name as read, never a prefix, so `__Host-d3person =x` goes too.
function M.strip_own_cookies(header)
  local kept = {}
  for _, pair in ipairs(split(header, ";")) do
    local trimmed = trim(pair)
    if #trimmed > 0 and not OWN_COOKIES[cookie_name(trimmed)] then kept[#kept + 1] = trimmed end
  end

  if #kept == 0 then return nil end
  return table.concat(kept, "; ")
end

local function unescape(s)
  return ngx.unescape_uri((string.gsub(s, "%+", " ")))
end

-- splitHandoffToken: a 22-char id, a dot, a 43-char signature, base64url both.
local function is_handoff_token(token)
  local id, sig = string.match(token, "^([A-Za-z0-9_-]+)%.([A-Za-z0-9_-]+)$")
  return id ~= nil and #id == 22 and #sig == 43
end

-- handoffFromUrl, from the query string: the first d3pay_handoff, if well formed.
function M.handoff_from_args(args)
  if args == nil or args == "" then return nil end
  for _, pair in ipairs(split(args, "&")) do
    local eq = string.find(pair, "=", 1, true)
    local name = eq and string.sub(pair, 1, eq - 1) or pair
    if unescape(name) == PAY_HANDOFF_PARAM then
      local value = unescape(eq and string.sub(pair, eq + 1) or "")
      if is_handoff_token(value) then return value end
      return nil
    end
  end
end

-- stripPayParams: the URL without our params; the rest keep their order and escapes.
function M.strip_pay_params(url)
  local query = string.find(url, "?", 1, true)
  if query == nil then return url end

  local kept = {}
  for _, pair in ipairs(split(string.sub(url, query + 1), "&")) do
    if not OWN_PARAMS[unescape(split(pair, "=")[1])] then kept[#kept + 1] = pair end
  end

  if #kept == 0 then return string.sub(url, 1, query - 1) end
  return string.sub(url, 1, query) .. table.concat(kept, "&")
end

-- ── Forwarding (forward-all.ts, extract.ts) ──────────────────────────────────

-- Header pairs as fetch's Headers iterates them: lowercase, sorted, repeats joined.
function M.header_entries(raw)
  local names = {}
  for name in pairs(raw) do names[#names + 1] = string.lower(name) end
  table.sort(names)
  local out = {}
  for _, name in ipairs(names) do
    local value = raw[name]
    if type(value) == "table" then value = table.concat(value, name == "cookie" and "; " or ", ") end
    out[#out + 1] = { name, value }
  end

  return out
end

local function entry_lookup(entries)
  local by_name = {}
  for _, entry in ipairs(entries) do by_name[entry[1]] = entry[2] end
  return by_name
end

M.lookup = entry_lookup

local function drop(out, candidate)
  local list = candidate.kind == "header" and out.droppedHeaders or out.droppedCookies
  list[#list + 1] = candidate.name
end

-- withinTotal: each over-long value goes, then the longest until the rest fit.
-- Ties keep arrival order, as JS's stable sort does; table.sort is not stable.
local function within_total(pooled, out)
  local fitting = {}
  for _, candidate in ipairs(pooled) do
    if #candidate.value > FORWARDED_VALUE_MAX_LENGTH then drop(out, candidate) else fitting[#fitting + 1] = candidate end
  end

  local function size(c) return #c.name + #c.value end
  local total = 0
  for _, c in ipairs(fitting) do total = total + size(c) end
  if total <= FORWARDED_MAX_TOTAL_LENGTH then return fitting end

  local order = {}
  for i, c in ipairs(fitting) do order[i] = { c = c, i = i } end
  table.sort(order, function(a, b)
    local sa, sb = size(a.c), size(b.c)
    if sa ~= sb then return sa > sb end
    return a.i < b.i
  end)

  local dropped = {}
  for _, o in ipairs(order) do
    if total <= FORWARDED_MAX_TOTAL_LENGTH then break end
    dropped[o.c] = true
    total = total - size(o.c)
    drop(out, o.c)
  end

  local kept = {}
  for _, c in ipairs(fitting) do if not dropped[c] then kept[#kept + 1] = c end end
  return kept
end

local function with_listed_drops(out)
  local function capped(list)
    local first = array()
    for i = 1, math.min(#list, FORWARDED_MAX_NAMES) do first[i] = list[i] end
    return first
  end

  out.droppedUnlisted = {
    headers = #out.droppedHeaders > FORWARDED_MAX_NAMES,
    cookies = #out.droppedCookies > FORWARDED_MAX_NAMES,
  }
  out.droppedHeaders = capped(out.droppedHeaders)
  out.droppedCookies = capped(out.droppedCookies)
  return out
end

-- forwardAll: every header and cookie but the never-sent, the excluded and our two cookies.
function M.forward_all(entries, exclude, caps)
  local excluded_headers = set_of(exclude.headers)
  local excluded_cookies = set_of(exclude.cookies)
  local out = { headers = {}, cookies = {}, droppedHeaders = array(), droppedCookies = array() }
  local pooled = {}

  for _, entry in ipairs(entries) do
    local name, value = entry[1], entry[2]
    if not NEVER_FORWARDED[name] and not excluded_headers[name] then
      local cap = caps[name]
      if cap ~= nil then
        if #value > cap then out.droppedHeaders[#out.droppedHeaders + 1] = name else out.headers[name] = value end
      else
        pooled[#pooled + 1] = { kind = "header", name = name, value = value }
      end
    end
  end

  -- The first of a repeated name, as readCookie and most servers read it.
  local seen, seen_count = {}, 0
  for _, cookie in ipairs(M.cookies_of(entry_lookup(entries)["cookie"])) do
    local name, value = cookie[1], cookie[2]
    if not OWN_COOKIES[name] and not excluded_cookies[name] and not seen[name] then
      seen[name] = true
      seen_count = seen_count + 1
      if seen_count > FORWARDED_MAX_COOKIES then
        out.droppedCookies[#out.droppedCookies + 1] = name
      else
        pooled[#pooled + 1] = { kind = "cookie", name = name, value = value }
      end
    end
  end

  for _, c in ipairs(within_total(pooled, out)) do
    if c.kind == "header" then out.headers[c.name] = c.value else out.cookies[c.name] = c.value end
  end

  return with_listed_drops(out)
end

-- Below revision 2: the fixed list, each header under its cap.
local function allowlisted(by_name)
  local headers, dropped = {}, array()
  for _, name in ipairs(M.FORWARDED_HEADERS) do
    local value = by_name[name]
    if value ~= nil then
      local cap = M.HEADER_LENGTH_CAPS[name]
      if cap ~= nil and #value > cap then dropped[#dropped + 1] = name else headers[name] = value end
    end
  end

  return { headers = headers, cookies = {}, droppedHeaders = dropped, droppedCookies = array(),
           droppedUnlisted = { headers = false, cookies = false } }
end

-- withheldOf: the exclusions echoed, and each kind past its lists flagged.
function M.withheld_of(exclude, dropped_unlisted)
  local function first(list)
    local out = array()
    for i = 1, math.min(#list, FORWARDED_MAX_NAMES) do out[i] = list[i] end
    return out
  end

  local unlisted = {
    headers = dropped_unlisted.headers or #exclude.headers > FORWARDED_MAX_NAMES,
    cookies = dropped_unlisted.cookies or #exclude.cookies > FORWARDED_MAX_NAMES,
  }
  local out = {}
  if unlisted.headers or unlisted.cookies then out.droppedUnlisted = unlisted end
  if #exclude.headers > 0 or #exclude.cookies > 0 then
    out.excluded = { headers = first(exclude.headers), cookies = first(exclude.cookies) }
  end

  return out
end

-- debugHeadersOf: for the request record alone, under DNA_DEBUG_LOG_RAW_PAYLOAD.
function M.debug_headers_of(entries, excluded)
  local kept_back = set_of(excluded)
  local out, kept = {}, 0
  for _, entry in ipairs(entries) do
    if kept == MAX_DEBUG_HEADERS then break end
    local name, value = entry[1], entry[2]
    if not NEVER_FORWARDED[name] and not kept_back[name] and #value <= MAX_DEBUG_HEADER_LENGTH then
      out[name] = value
      kept = kept + 1
    end
  end

  return out
end

-- ── Payment presence (payment-header.ts) ─────────────────────────────────────

-- hasPaymentHeader over the visitor's headers: presence under the cap, never a decode.
function M.has_payment_header(by_name)
  for name, cap in pairs(PAYMENT_HEADER_CAPS) do
    local value = by_name[name]
    if value ~= nil and #value > 0 and #value <= cap then return true end
  end

  local session = M.read_cookie(by_name["cookie"], PAY_SESSION_COOKIE)
  return session ~= nil and #session > 0 and #session <= COOKIE_TOKEN_MAX
end

-- edgeRequestPresentsPayment: on the request, or lifted from an MCP call onto the payload.
function M.presents_payment(by_name, args, payload_headers)
  return M.has_payment_header(by_name) or M.handoff_from_args(args) ~= nil
    or M.has_payment_header(payload_headers)
end

function M.is_acme_challenge(path)
  return string.sub(path, 1, #ACME_PREFIX) == ACME_PREFIX
end

-- ── MCP (mcp.ts) ─────────────────────────────────────────────────────────────

local function is_json_type(content_type)
  local kind = string.lower(trim(string.match(content_type or "", "^[^;]*")))
  return kind == "application/json" or string.sub(kind, -5) == "+json"
end

M.is_json_type = is_json_type

-- readJsonRpcRequest: one call in a JSON POST body, else nil. `id` is nil when absent.
-- The second result is true for a JSON POST cjson could not read at all.
function M.read_json_rpc_request(method, content_type, body)
  if method ~= "POST" or not is_json_type(content_type) then return nil end
  if #body == 0 or #body > M.MCP_BODY_MAX_BYTES then return nil end

  local parsed = M.json_decode(body)
  if parsed == nil then return nil, true end
  if not is_record(parsed) or parsed.jsonrpc ~= "2.0" or type(parsed.method) ~= "string" then return nil end

  local id = parsed.id
  if id ~= nil and id ~= NULL and type(id) ~= "string" and type(id) ~= "number" then return nil end

  return { id = id, method = parsed.method, params = is_record(parsed.params) and parsed.params or nil }
end

-- A byte search, not a parse: a key hidden behind JSON escapes is the client hiding its own credential.
local function names_credential(body)
  for _, key in ipairs({ MCP_X402_META, MCP_DNA_KEY_META, MCP_KEY_ARGUMENT }) do
    if string.find(body, '"' .. key .. '"', 1, true) then return true end
  end

  return false
end

-- A JSON POST past the read cap whose bytes name a credential key: it cannot be stripped.
function M.oversized_call_names_credential(method, content_type, body)
  if method ~= "POST" or not is_json_type(content_type) or #body <= M.MCP_BODY_MAX_BYTES then return false end
  return names_credential(body)
end

-- recordableName: no query, fragment or userinfo in what the record keeps.
function M.recordable_name(name)
  if name == nil or name == "" then return nil end
  local base = string.match(name, "^[^?#]*")
  local scheme, rest = string.match(base, "^([A-Za-z][A-Za-z0-9+.%-]*://)[^/@]*@(.*)$")
  if scheme then return scheme .. rest end
  return base
end

local function bounded(value, max)
  if type(value) == "string" and #value > 0 and #value <= max and string.find(value, "^[\32-\126]+$") then
    return value
  end
end

local function name_in_call(rpc)
  local params = rpc.params
  if params == nil then return nil end
  if rpc.method == "resources/read" then return M.recordable_name(string_or_nil(params.uri)) end
  if rpc.method == "tools/call" or rpc.method == "prompts/get" then return string_or_nil(params.name) end
end

-- mcpFactsOf: the body when one call was read, the Mcp-* mirrors otherwise, never a mix.
function M.mcp_facts_of(get_header, rpc, excluded)
  local function mirror(name)
    if contains(excluded, name) then return nil end
    return get_header(name)
  end

  local method, tool
  if rpc then
    method = bounded(rpc.method, MCP_METHOD_MAX_LENGTH)
    tool = bounded(name_in_call(rpc), MCP_NAME_MAX_LENGTH)
  else
    method = bounded(mirror("mcp-method"), MCP_METHOD_MAX_LENGTH)
    tool = bounded(M.recordable_name(mirror("mcp-name")), MCP_NAME_MAX_LENGTH)
  end

  if not method and not tool then return nil end
  return { method = method, tool = tool, source = rpc and "body" or "headers" }
end

-- liftMcpPayment: the call's payment as the headers the worker reads, and the body without it.
function M.lift_mcp_payment(rpc)
  local params = rpc.params
  if params == nil then return {}, nil end

  local lifted = {}
  local meta = is_record(params._meta) and copy(params._meta) or nil
  local args = is_record(params.arguments) and copy(params.arguments) or nil
  local changed = false

  if meta and meta[MCP_X402_META] ~= nil then
    local payment = meta[MCP_X402_META]
    if is_record(payment) then lifted["payment-signature"] = ngx.encode_base64(M.json_encode(payment)) end
    meta[MCP_X402_META] = nil
    changed = true
  end

  if meta and meta[MCP_DNA_KEY_META] ~= nil then
    local key = string_or_nil(meta[MCP_DNA_KEY_META])
    if key then lifted["payment-authorization"] = "Payment " .. key end
    meta[MCP_DNA_KEY_META] = nil
    changed = true
  end

  if rpc.method == "tools/call" and args and args[MCP_KEY_ARGUMENT] ~= nil then
    local key = string_or_nil(args[MCP_KEY_ARGUMENT])
    if key and lifted["payment-authorization"] == nil then lifted["payment-authorization"] = "Payment " .. key end
    args[MCP_KEY_ARGUMENT] = nil
    changed = true
  end

  if not changed then return lifted, nil end

  local origin_params = {}
  for k, v in pairs(params) do
    if k ~= "_meta" and k ~= "arguments" then origin_params[k] = v end
  end
  if args then origin_params.arguments = args end
  if meta and count_keys(meta) > 0 then origin_params._meta = meta end

  local call = { jsonrpc = "2.0", method = rpc.method, params = origin_params, id = rpc.id }
  return lifted, M.json_encode(call)
end

-- mcpCarriageOf: everything revision 3 reads off a request. `body` is nil for one
-- streamed from disk, whose credential search `streamed` already holds.
function M.mcp_carriage_of(method, get_header, body, excluded, streamed)
  local content_type = get_header("content-type")
  local rpc, undecodable
  if body ~= nil then rpc, undecodable = M.read_json_rpc_request(method, content_type, body) end
  local facts = M.mcp_facts_of(get_header, rpc, excluded)
  local lifted, origin_body = {}, nil
  if rpc then lifted, origin_body = M.lift_mcp_payment(rpc) end

  local mirrored = string_or_nil(get_header(MCP_DNA_KEY_HEADER))
  if mirrored and lifted["payment-authorization"] == nil then
    lifted["payment-authorization"] = "Payment " .. mirrored
  end

  return {
    rpc = rpc,
    facts = facts,
    lifted = lifted,
    origin_body = origin_body,
    -- cjson refuses what JSON.parse reads (a lone surrogate escape, nesting past 1,000), so a
    -- call only it cannot read is refused like one too large to read, if it names a credential.
    unreadable_credential = (streamed ~= nil and streamed.names_credential)
      or (body ~= nil and M.oversized_call_names_credential(method, content_type, body))
      or (undecodable == true and names_credential(body)),
  }
end

-- liftedPaymentToForward: a header the client sent wins over the body, family by family.
function M.lifted_payment_to_forward(sent, lifted)
  local out = {}
  for _, family in ipairs({ { "payment-signature", "x-payment" }, { "payment-authorization" } }) do
    local sent_one = false
    for _, name in ipairs(family) do if sent[name] ~= nil then sent_one = true end end
    if not sent_one then
      for _, name in ipairs(family) do if lifted[name] ~= nil then out[name] = lifted[name] end end
    end
  end

  return out
end

-- ── The payload (extractEdgeRequest) ─────────────────────────────────────────

local function content_digest(body)
  local digest = sha256:new()
  digest:update(body)
  return "sha-256=:" .. ngx.encode_base64(digest:final()) .. ":"
end

-- req: method, url (path and query), host, ip, secure, entries, body; opts: revision, exclude, debug.
function M.extract(req, opts)
  local revision = opts.revision
  local exclude = opts.exclude
  local by_name = entry_lookup(req.entries)
  local forwards_all = revision >= FORWARDS_ALL_SINCE
  local forwarded = forwards_all and M.forward_all(req.entries, exclude, M.HEADER_LENGTH_CAPS)
    or allowlisted(by_name)
  local headers, dropped = forwarded.headers, forwarded.droppedHeaders

  for _, own in ipairs({ { PAY_SESSION_COOKIE, PAY_SESSION_HEADER }, { PERSON_PASS_COOKIE, PERSON_PASS_HEADER } }) do
    local value = M.read_cookie(by_name["cookie"], own[1])
    if value ~= nil and #value > 0 and #value <= COOKIE_TOKEN_MAX then headers[own[2]] = value end
  end

  -- Overwritten whenever there is a body or a claimed digest: a forged one never passes through.
  local can_have_body = req.method ~= "GET" and req.method ~= "HEAD"
  local streamed = can_have_body and req.streamed or nil
  local body = nil
  if streamed then
    headers["content-digest"] = streamed.digest
  else
    body = can_have_body and (req.body or "") or ""
    if #body > 0 or headers["content-digest"] ~= nil then headers["content-digest"] = content_digest(body) end
  end

  local mcp = nil
  if revision >= CARRIES_MCP_SINCE then
    mcp = M.mcp_carriage_of(req.method, function(name) return by_name[name] end, body, exclude.headers, streamed)
  end

  for name, value in pairs(M.lifted_payment_to_forward(by_name, mcp and mcp.lifted or {})) do
    -- The site's exclusion binds a lifted credential as it binds the header.
    if not contains(exclude.headers, name) then
      local cap = M.HEADER_LENGTH_CAPS[name]
      if cap ~= nil and #value > cap then dropped[#dropped + 1] = name else headers[name] = value end
    end
  end

  local payload = {
    ip = req.ip,
    headerSet = M.FORWARDED_HEADER_SET,
    adapterSet = revision,
    secure = req.secure,
    method = req.method,
    url = req.url,
    host = req.host,
    timestamp = req.timestamp,
    headers = headers,
  }
  if #dropped > 0 then payload.droppedHeaders = dropped end
  if forwards_all then
    payload.cookies = forwarded.cookies
    for k, v in pairs(M.withheld_of(exclude, forwarded.droppedUnlisted)) do payload[k] = v end
  end
  if #forwarded.droppedCookies > 0 then payload.droppedCookies = forwarded.droppedCookies end
  if mcp and mcp.facts then payload.mcp = mcp.facts end
  if opts.debug then payload.debugHeaders = M.debug_headers_of(req.entries, exclude.headers) end

  return payload, mcp
end

-- ── Answers (payment-response.ts) ────────────────────────────────────────────

-- Provider and tenant authored, and this is the last place before nginx's header
-- table: a CR or LF through here is response splitting. Dropped, never escaped.
function M.header_safe(name, value)
  if type(name) ~= "string" or type(value) ~= "string" then return false end
  if #name == 0 or #name > 64 or #value == 0 or #value > 8192 then return false end
  if string.find(name, "[^A-Za-z0-9!#$%%&'*+.%^_`|~%-]") ~= nil then return false end
  return string.find(value, "[^\32-\126]") == nil
end

function M.header_safe_payment_headers(headers)
  local safe = {}
  if not is_record(headers) then return safe end
  for name, value in pairs(headers) do
    if M.header_safe(name, value) then safe[name] = value end
  end

  return safe
end

function M.payment_edge_mode(status)
  if status == 402 then return "payment-required" end
  if status >= 300 and status <= 399 then return "payment-redirect" end
  if status == 200 then return "payment-stub" end
  return "fail-closed"
end

-- Headers are a list, applied in order with later names winning, as a JS object literal spreads.
local function answer(status, body, headers, mode)
  local list = {}
  for _, pair in ipairs(headers) do list[#list + 1] = pair end
  list[#list + 1] = { "x-d3-edge", mode }
  local content_type = false
  for _, pair in ipairs(list) do
    if string.lower(pair[1]) == "content-type" then content_type = true end
  end
  return { status = status, body = body, headers = list, mode = mode, content_type = content_type }
end

local function payment_header_pairs(payment)
  local safe, pairs_out = M.header_safe_payment_headers(payment.headers), {}
  local names = {}
  for name in pairs(safe) do names[#names + 1] = name end
  table.sort(names)
  for _, name in ipairs(names) do pairs_out[#pairs_out + 1] = { name, safe[name] } end
  return pairs_out
end

local JSON_TYPE = "application/json; charset=utf-8"

local build_payment_answer

-- The MCP binding answers in band: a 200 with the result, whatever the status says.
local function json_rpc_answer(payment, mode, id)
  local result = type(payment.body) == "string" and M.json_decode(payment.body) or nil
  if result == nil then
    return build_payment_answer({ status = 502, body = '{"error":"payment_unavailable"}' }, "fail-closed")
  end

  local headers = { { "content-type", JSON_TYPE }, { "cache-control", "no-store" } }
  for _, pair in ipairs(payment_header_pairs(payment)) do headers[#headers + 1] = pair end
  return answer(200, M.json_encode({ jsonrpc = "2.0", id = id, result = result }), headers, mode)
end

-- buildPaymentResponse: rpc_id nil when no call was read, M.null for a null id.
build_payment_answer = function(payment, mode, rpc_id)
  if payment.bodyKind == "json-rpc" and rpc_id ~= nil then return json_rpc_answer(payment, mode, rpc_id) end

  local status = tonumber(payment.status) or 502
  local headers = {}
  -- A redirect carries no content type: a JSON type on it misleads the client that follows it.
  if not (status >= 300 and status <= 399) then headers[#headers + 1] = { "content-type", JSON_TYPE } end
  headers[#headers + 1] = { "cache-control", "no-store" }
  for _, pair in ipairs(payment_header_pairs(payment)) do headers[#headers + 1] = pair end
  return answer(status, type(payment.body) == "string" and payment.body or nil, headers, mode)
end

M.build_payment_answer = build_payment_answer

function M.block_answer(decision, mode)
  local verdict = is_record(decision) and is_record(decision.verdict) and decision.verdict or {}
  local body = { blocked = true }
  if is_record(decision) and type(decision.ruleId) == "string" then body.ruleId = decision.ruleId end
  if type(verdict.tier) == "string" then body.tier = verdict.tier end
  if type(verdict.identity) == "string" then body.identity = verdict.identity end
  return answer(403, M.json_encode(body), { { "content-type", JSON_TYPE } }, mode)
end

function M.payment_unavailable_answer()
  return answer(502, '{"error":"payment_unavailable"}',
    { { "content-type", JSON_TYPE }, { "cache-control", "no-store" } }, "fail-closed")
end

-- unreadableCallResponse: a call too large to strip that names our credential.
function M.unreadable_call_answer()
  return answer(413, '{"error":"mcp_call_too_large"}',
    { { "content-type", JSON_TYPE }, { "cache-control", "no-store" } }, "fail-closed")
end

-- Appended to the origin's own; every other payment header replaces the origin's.
M.MERGED_HEADERS = set_of({ "access-control-expose-headers", "set-cookie" })

-- privateCacheControl: a receipt or our Set-Cookie is one visitor's, so no shared cache holds it.
function M.private_cache_control(origin)
  local directives = {}
  for _, part in ipairs(split(origin or "", ",")) do
    local trimmed = trim(part)
    if #trimmed > 0 then directives[#directives + 1] = trimmed end
  end
  if #directives == 0 then return "private" end

  local shared
  for i, directive in ipairs(directives) do
    local name = string.lower(string.match(directive, "^[^=]*"))
    if name == "private" or name == "no-store" then return table.concat(directives, ", ") end
    if name == "public" and shared == nil then shared = i end
  end
  if shared == nil then return "private, " .. table.concat(directives, ", ") end

  directives[shared] = "private"
  return table.concat(directives, ", ")
end

-- ── The origin's MCP answer (mcp-response.ts) ────────────────────────────────

local function with_key_argument(tool)
  if not is_record(tool) then return tool end
  local schema = is_record(tool.inputSchema) and copy(tool.inputSchema) or { type = "object" }
  local properties = is_record(schema.properties) and copy(schema.properties) or {}
  properties[MCP_KEY_ARGUMENT] = M.MCP_KEY_ARGUMENT_SCHEMA
  schema.properties = properties
  local out = copy(tool)
  out.inputSchema = schema
  return out
end

-- rewriteResult: the result with our _meta and, on tools/list, the key argument; nil leaves it alone.
function M.rewrite_result(body, meta, lists_tools)
  local parsed = M.json_decode(body)
  if not is_record(parsed) or parsed.jsonrpc ~= "2.0" or not is_record(parsed.result) then return nil end

  local result = copy(parsed.result)
  if meta then
    local merged = is_record(result._meta) and copy(result._meta) or {}
    for k, v in pairs(meta) do merged[k] = v end
    result._meta = merged
  end

  if lists_tools and is_array(result.tools) then
    local tools = array()
    for i, tool in ipairs(result.tools) do tools[i] = with_key_argument(tool) end
    result.tools = tools
  end

  local out = copy(parsed)
  out.result = result
  return M.json_encode(out)
end

-- The edits withMcpResult makes, or nil when it would pass the answer untouched.
function M.mcp_result_edits(method, meta, key_argument)
  local has_meta = is_record(meta) and count_keys(meta) > 0
  local lists_tools = key_argument and method == "tools/list"
  if not has_meta and not lists_tools then return nil end
  return { meta = has_meta and meta or nil, lists_tools = lists_tools }
end

-- Per nginx worker, as the packages keep it per isolate: whether a host's site
-- turned the key argument on, as its last decision said.
local key_argument_memory = lrucache.new(MCP_KEY_ARGUMENT_MAX_HOSTS)

function M.remember_key_argument(host, on)
  if on then key_argument_memory:set(host, true, MCP_KEY_ARGUMENT_MEMORY_S) else key_argument_memory:delete(host) end
end

function M.key_argument_on(host)
  return key_argument_memory:get(host) == true
end

-- ── The report (types.ts ResponseReport) ─────────────────────────────────────

-- `new URL('/v1/report', endpoint)`: the endpoint's origin, this path.
function M.report_url(endpoint)
  local origin = string.match(endpoint, "^(https?://[^/?#]+)")
  return origin and (origin .. "/v1/report") or nil
end

-- pathOf: the URL's path, without the query.
function M.path_of(url)
  return string.match(url, "^[^?]*")
end

-- Request state, per worker, keyed by a ref the access phase puts on the
-- response: nginx resets ngx.ctx on an internal redirect (try_files to @app),
-- and keeps the response headers.
M.REF_HEADER = "x-d3-ref"
local states = lrucache.new(20000)
local STATE_TTL_S = 300

function M.save_state(ref, state) states:set(ref, state, STATE_TTL_S) end

-- One line per key per worker per interval, not one per request: a DNA outage or
-- a misconfigured location would otherwise flood the error log.
local logged = lrucache.new(1000)

function M.log_every(key, seconds, level, ...)
  if logged:get(key) then return end
  logged:set(key, true, seconds)
  ngx.log(level, ...)
end
function M.load_state(ref) return ref and states:get(ref) or nil end
function M.forget_state(ref) if ref then states:delete(ref) end end

-- ── The access phase ─────────────────────────────────────────────────────────

-- Asks DNA about one request and answers as it says: the page, a block, or a
-- gate's own answer. Fails open, except for a request that pays. `revision` is
-- what the install honours: 3 from dna.server.conf, which also installs the
-- response half, 1 from an access line alone.
-- ── The phases ───────────────────────────────────────────────────────────────

-- nginx reads `X_D3_Tier` as the same header under underscores_in_headers, so every spelling goes.
local VERDICT_HEADERS = { ["x-d3-tier"] = true, ["x-d3-identity"] = true }

-- Only DNA's verdict may reach the upstream under these names, never a visitor's.
function M.clear_verdict_headers()
  for name in pairs(ngx.req.get_headers(0, true)) do
    if VERDICT_HEADERS[string.lower((string.gsub(name, "_", "-")))] then ngx.req.clear_header(name) end
  end
end

-- No credential of ours and no visitor's verdict reaches the origin, in a header,
-- a cookie or the URL, whether DNA answered, failed, or is turned off.
function M.strip_for_origin(by_name)
  for _, name in ipairs(M.ORIGIN_STRIPPED_HEADERS) do ngx.req.clear_header(name) end
  M.clear_verdict_headers()

  local cookie = by_name["cookie"]
  if cookie and (M.read_cookie(cookie, PAY_SESSION_COOKIE) or M.read_cookie(cookie, PERSON_PASS_COOKIE)) then
    local kept = M.strip_own_cookies(cookie)
    if kept == nil then ngx.req.clear_header("Cookie") else ngx.req.set_header("Cookie", kept) end
  end

  -- $args, not ngx.req.set_uri_args(): that re-escapes, so a %XX already in the
  -- query would reach the origin double-encoded.
  local args = ngx.var.args
  if args ~= nil and args ~= "" then
    local kept = string.sub(M.strip_pay_params("?" .. args), 2)
    if kept ~= args then ngx.var.args = kept end
  end
end

local BODY_CHUNK = 65536

-- The body as the payload needs it. In memory, or a JSON call small enough to
-- read, it comes back whole. Anything else nginx spilled to disk is streamed for
-- its digest and, for JSON, searched for our credential keys, never held whole.
function M.read_body(method, content_type)
  ngx.req.read_body()
  local data = ngx.req.get_body_data()
  if data ~= nil then return { data = data } end

  local file = ngx.req.get_body_file()
  local f = file and io.open(file, "rb")
  if not f then return { data = "" } end

  local json_call = method == "POST" and is_json_type(content_type)
  local size = f:seek("end")
  f:seek("set")
  if json_call and size <= M.MCP_BODY_MAX_BYTES then
    local whole = f:read("*a")
    f:close()
    return { data = whole }
  end

  local digest, tail, names = sha256:new(), "", false
  while true do
    local chunk = f:read(BODY_CHUNK)
    if chunk == nil then break end
    digest:update(chunk)
    if json_call and not names then
      -- The previous chunk's tail keeps a key split across two chunks findable.
      names = names_credential(tail .. chunk)
      tail = string.sub(chunk, -32)
    end
  end
  f:close()

  local streamed = { digest = "sha-256=:" .. ngx.encode_base64(digest:final()) .. ":", names_credential = names }
  return { streamed = streamed }
end

local function post_decision(settings, payload, budget_ms)
  local httpc = http.new()
  httpc:set_timeout(budget_ms)
  return httpc:request_uri(settings.endpoint, {
    method = "POST",
    body = M.json_encode(payload),
    ssl_verify = true,
    headers = {
      ["Content-Type"] = "application/json",
      ["Authorization"] = settings.api_key and ("Bearer " .. settings.api_key) or nil,
    },
  })
end

-- set_timeout bounds each socket step, not the call: a resolver that never
-- answers, or a decision trickled a byte at a time, would hold the request far
-- past the budget. The call races a sleep, and the loser is killed.
local function decide(settings, payload, budget_ms)
  local call = ngx.thread.spawn(post_decision, settings, payload, budget_ms)
  local clock = ngx.thread.spawn(function() ngx.sleep(budget_ms / 1000) end)
  local ok, res, err = ngx.thread.wait(call, clock)
  ngx.thread.kill(call)
  ngx.thread.kill(clock)
  if not ok then return nil, tostring(res) end
  if res == nil and err == nil then return nil, "deadline" end
  return res, err
end

-- Asks DNA about one request and answers as it says: the page, a block, or a
-- gate's own answer. Fails open, except for a request that pays. `revision` is
-- what the install honours: 3 from dna.server.conf, which also installs the
-- response half, 1 from an access line alone.
function M.access(revision)
  -- M.log reads this: a location whose own access_by_lua replaced DNA's never sets it.
  ngx.ctx.dna_asked = true

  -- Decided already, before an internal redirect (try_files, index, error_page):
  -- every answer that lets the request on sets x-d3-edge, and the credentials are
  -- already off the request, so a second decision would read a paying visitor as
  -- an unpaid one. It holds across both entry points, so a config upgraded in one
  -- location and not another still decides once.
  if ngx.header["x-d3-edge"] ~= nil then return end

  local entries = M.header_entries(ngx.req.get_headers(0))
  local by_name = M.lookup(entries)

  local settings = M.cached_settings(os.getenv)
  if not settings.endpoint then
    M.strip_for_origin(by_name)
    ngx.header["x-d3-edge"] = "disabled"
    return
  end

  -- $uri, the path nginx routes on: decoded and its dot segments resolved, so
  -- `/.well-known/acme-challenge/../../page` is `/page` here too.
  if M.is_acme_challenge(ngx.var.uri) then
    M.strip_for_origin(by_name)
    ngx.header["x-d3-edge"] = "pass"
    return
  end

  local method = ngx.req.get_method()
  local body = M.read_body(method, by_name["content-type"])
  local request_uri = ngx.var.request_uri
  local host = ngx.var.http_host or ngx.var.host
  local request_id = ngx.var.request_id

  local payload, mcp = M.extract({
    method = method,
    url = request_uri,
    host = host,
    ip = ngx.var.remote_addr,
    secure = ngx.var.scheme == "https",
    timestamp = ngx.now(),
    entries = entries,
    body = body.data,
    streamed = body.streamed,
  }, { revision = revision, exclude = settings.exclude, debug = settings.debug_log_raw_payload })
  payload.requestId = request_id

  local state = {
    ref = request_id,
    request_id = request_id,
    host = host,
    path = M.path_of(request_uri),
    method = method,
    revision = revision,
  }
  ngx.ctx.dna = state
  if revision == M.ADAPTER_SET then
    M.save_state(request_id, state)
    ngx.header[M.REF_HEADER] = request_id
  end

  -- Our own answer, whole. The report carries it.
  local function send(built)
    state.mode = built.mode
    state.answer = built
    ngx.status = built.status
    for _, pair in ipairs(built.headers) do ngx.header[pair[1]] = pair[2] end
    -- Lua would otherwise fill in nginx's default_type.
    if not built.content_type then ngx.header["Content-Type"] = nil end
    if built.body then
      ngx.print(built.body)
    else
      -- Without this, nginx fills an empty 302 with its own HTML page.
      ngx.header["Content-Length"] = 0
      ngx.send_headers()
    end

    return ngx.exit(ngx.HTTP_OK)
  end

  -- Also on fail-open: an endpoint we could not reach is no reason to hand the origin a credential.
  local function to_origin()
    M.strip_for_origin(by_name)
    if mcp and mcp.origin_body then
      ngx.req.set_body_data(mcp.origin_body)
      ngx.req.clear_header("Content-Digest")
    end
  end

  local paying = M.presents_payment(by_name, ngx.var.args, payload.headers)

  if mcp and mcp.unreadable_credential then return send(M.unreadable_call_answer()) end

  local res, err = decide(settings, payload, paying and settings.payment_timeout_ms or settings.timeout_ms)
  local decision = res and res.status >= 200 and res.status < 300 and M.json_decode(res.body) or nil
  if not M.is_record(decision) or (decision.action ~= "pass" and decision.action ~= "block") then
    local reason = err or (res and ("HTTP " .. res.status)) or "invalid decision"
    -- A dead key fails open and looks like a working site: this line is how it gets found.
    if res and (res.status == 401 or res.status == 403) then reason = reason .. ", check DNA_API_KEY: " .. tostring(res.body) end
    M.log_every("decision " .. (err or (res and res.status) or "invalid"), 10, ngx.ERR,
      "dna: decision call failed (", reason, "), and again until this stops")
    -- Nothing to report to an endpoint that could not be reached at all.
    if res == nil and err ~= "timeout" and err ~= "deadline" then state.no_report = true end
    -- A paying request never falls open: the page is priced and the charge may already have landed.
    if paying then return send(M.payment_unavailable_answer()) end
    if settings.fail_mode == "closed" then return send(M.block_answer(nil, "fail-closed")) end

    to_origin()
    state.mode = "fail-open"
    ngx.header["x-d3-edge"] = "fail-open"
    return
  end

  if decision.mcpKeyArgument ~= nil then M.remember_key_argument(host, decision.mcpKeyArgument == true) end

  if decision.action == "block" then return send(M.block_answer(decision, "block")) end

  local payment = M.is_record(decision.payment) and decision.payment or nil
  if payment and payment.status ~= nil then
    local mode = M.payment_edge_mode(tonumber(payment.status) or 502)
    return send(M.build_payment_answer(payment, mode, mcp and mcp.rpc and mcp.rpc.id))
  end

  to_origin()

  -- Set here, so proxy_pass adds the origin's Set-Cookie beside ours rather than
  -- replacing it; M.header_filter then narrows the origin's caching.
  local paid_headers = M.header_safe_payment_headers(payment and payment.headers)
  for name, value in pairs(paid_headers) do ngx.header[name] = value end
  if next(paid_headers) ~= nil then state.payment_headers = paid_headers end

  if mcp and mcp.rpc then
    state.mcp_edits = M.mcp_result_edits(mcp.rpc.method, payment and payment.meta, M.key_argument_on(host))
    -- A compressed answer cannot be rewritten, so the receipt would be lost.
    if state.mcp_edits then ngx.req.clear_header("Accept-Encoding") end
  end

  state.mode = "pass"
  ngx.header["x-d3-edge"] = "pass"
  -- From revision 2 DNA may pass before working out who is asking (ADR 0072): no verdict, no headers.
  local verdict = decision.verdict
  if M.is_record(verdict) then
    ngx.req.set_header("X-D3-Tier", type(verdict.tier) == "string" and verdict.tier or "")
    ngx.req.set_header("X-D3-Identity", type(verdict.identity) == "string" and verdict.identity or "")
  end
end

local function response_cache_control()
  local value = ngx.header["Cache-Control"]
  if type(value) == "table" then return table.concat(value, ", ") end
  return value
end

-- The origin's response headers: a paid page narrowed to private caching, and an
-- MCP result DNA adds to readied for M.body_filter.
function M.header_filter()
  local ref = ngx.header[M.REF_HEADER]
  if ref == nil then return end
  ngx.header[M.REF_HEADER] = nil

  -- After an internal redirect ngx.ctx is new, so the access phase's state comes back by its ref.
  local state = ngx.ctx.dna or M.load_state(ref)
  if not state then return end
  ngx.ctx.dna = state
  state.response_half = true

  if state.answer then return end
  if state.mode then ngx.header["x-d3-edge"] = state.mode end

  if state.payment_headers then
    -- The receipt replaces any the origin sent; Set-Cookie and the CORS list were appended in the access phase.
    for name, value in pairs(state.payment_headers) do
      if not M.MERGED_HEADERS[string.lower(name)] then ngx.header[name] = value end
    end
    ngx.header["Cache-Control"] = M.private_cache_control(response_cache_control())
  end

  local edits = state.mcp_edits
  if edits == nil then return end

  local status = ngx.status
  local declared = tonumber(ngx.header["Content-Length"])
  local encoding = ngx.header["Content-Encoding"]
  if not is_json_type(ngx.header["Content-Type"]) or status == 204 or status == 304
    or ngx.req.get_method() == "HEAD" or (declared and declared > M.MCP_RESULT_MAX_BYTES) then
    return
  end

  if encoding ~= nil and encoding ~= "identity" then
    M.log_every("encoded " .. ngx.var.uri, 3600, ngx.WARN, "dna: ", ngx.var.uri, " answered an MCP call ",
      tostring(encoding), "-encoded, so DNA could not add its receipt")
    return
  end

  state.rewrite = { chunks = {}, bytes = 0 }
  -- They describe the origin's bytes, which the rewrite changes. Dropped before
  -- the body is seen, so an answer left alone loses them too.
  for _, name in ipairs({ "Content-Length", "Content-Digest", "Repr-Digest", "Content-MD5", "ETag" }) do
    ngx.header[name] = nil
  end
  if edits.meta then ngx.header["Cache-Control"] = M.private_cache_control(response_cache_control()) end
end

-- The origin's MCP result: held whole up to the cap and given the receipt in its
-- _meta or the key argument on tools/list. Past the cap it streams as it came.
function M.body_filter()
  local state = ngx.ctx.dna
  local rewrite = state and state.rewrite
  if not rewrite then return end
  rewrite.seen = true
  if rewrite.passing then return end

  local chunk, eof = ngx.arg[1], ngx.arg[2]
  rewrite.chunks[#rewrite.chunks + 1] = chunk
  rewrite.bytes = rewrite.bytes + #chunk

  if rewrite.bytes > M.MCP_RESULT_MAX_BYTES then
    rewrite.passing = true
    ngx.arg[1] = table.concat(rewrite.chunks)
    rewrite.chunks = nil
    return
  end

  if not eof then
    ngx.arg[1] = nil
    return
  end

  local whole = table.concat(rewrite.chunks)
  rewrite.chunks = nil
  ngx.arg[1] = M.rewrite_result(whole, state.mcp_edits.meta, state.mcp_edits.lists_tools) or whole
end

local function post_report(premature, url, api_key, body)
  if premature then return end

  local httpc = http.new()
  httpc:set_timeout(3000)
  local res, err = httpc:request_uri(url, {
    method = "POST",
    body = body,
    ssl_verify = true,
    headers = {
      ["Content-Type"] = "application/json",
      ["Authorization"] = api_key and ("Bearer " .. api_key) or nil,
    },
  })
  if not res or res.status >= 300 then
    M.log_every("report failed", 60, ngx.ERR, "dna: response report failed (", err or ("HTTP " .. res.status),
      "), and again until this stops")
  end
end

local function response_header(name)
  local value = ngx.header[name]
  if type(value) == "table" then return table.concat(value, ", ") end
  return value
end

-- After the response: reports what the visitor got to /v1/report, without delaying anyone.
function M.log()
  local uri = ngx.var.uri
  local state = ngx.ctx.dna
  if not state then
    -- After an internal redirect only the marker on the response still names it.
    local ref = ngx.header[M.REF_HEADER]
    state = M.load_state(type(ref) == "string" and ref or nil)
  end

  if not state then
    if not ngx.ctx.dna_asked and M.cached_settings(os.getenv).endpoint then
      M.log_every("access " .. uri, 3600, ngx.ERR, "dna: ", uri,
        " runs its own access_by_lua, which replaces DNA's: DNA never asks about it")
    end
    return
  end

  if state.revision == M.ADAPTER_SET and not state.answer and not state.response_half then
    M.log_every("header " .. uri, 3600, ngx.ERR, "dna: ", uri, " runs its own header_filter_by_lua, which",
      " replaces DNA's: a paid page there keeps the origin's caching, and an MCP result gets no receipt")
  elseif state.rewrite and not state.rewrite.seen then
    M.log_every("body " .. uri, 3600, ngx.ERR, "dna: ", uri,
      " runs its own body_filter_by_lua, which replaces DNA's: an MCP result gets no receipt")
  end

  M.forget_state(state.ref)
  if not state.mode or state.no_report then return end

  local settings = M.cached_settings(os.getenv)
  local url = settings.endpoint and M.report_url(settings.endpoint)
  if not url then return end

  local report = {
    requestId = state.request_id,
    ts = math.floor(ngx.now() * 1000),
    host = state.host,
    path = state.path,
    method = state.method,
    mode = state.mode,
    status = ngx.status,
    contentType = response_header("Content-Type"),
    contentLength = tonumber(response_header("Content-Length")) or tonumber(ngx.var.body_bytes_sent),
  }

  if state.answer then
    local headers = {}
    for _, pair in ipairs(state.answer.headers) do headers[string.lower(pair[1])] = pair[2] end
    report.answer = { headers = headers, body = state.answer.body }
  else
    -- Seconds per upstream tried, comma-separated; the origin round trip is their sum.
    local times = ngx.var.upstream_response_time
    if times then
      local total, any = 0, false
      for t in string.gmatch(times, "[%d.]+") do
        total = total + tonumber(t)
        any = true
      end
      if any then report.originLatencyMs = math.floor(total * 1000 + 0.5) end
    end
  end

  -- The log phase cannot open a connection, so a timer sends it. Each report holds
  -- a timer while it waits; past these the site's own timers keep their headroom.
  if ngx.timer.pending_count() < 256 and ngx.timer.running_count() < 128 then
    local ok, err = ngx.timer.at(0, post_report, url, settings.api_key, M.json_encode(report))
    if not ok then M.log_every("report dropped", 60, ngx.ERR, "dna: response report dropped (", err, ")") end
  else
    M.log_every("report dropped", 60, ngx.WARN, "dna: response reports dropped: too many timers running")
  end
end

return M
