-- The OpenResty port checked against the protocol package (parity.json), plus
-- the reject paths only the port has. Runs under OpenResty's `resty`:
--   resty nginx/test/unit.lua            (from the repo root, or via run.sh)
local here = arg[0]:match("^(.*/)") or "./"
local dna = dofile(here .. "../dna.lua")
local cjson = require("cjson.safe").new()
cjson.decode_array_with_array_mt(true)
local NULL = cjson.null

local failed, passed = 0, 0
local function check(name, ok, detail)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    print("  FAIL " .. name .. (detail and ("\n       " .. detail) or ""))
  end
end

-- Arrays by metatable or as a 1..n sequence; NULL and nil read alike; keys sorted.
local function canonical(v)
  if v == nil or v == NULL then return "null" end
  if type(v) == "number" then return string.format("%.17g", v) end
  if type(v) == "string" then return string.format("%q", v) end
  if type(v) ~= "table" then return tostring(v) end

  local n = 0
  for _ in pairs(v) do n = n + 1 end
  if getmetatable(v) == cjson.array_mt or (n > 0 and n == #v) then
    local parts = {}
    for i = 1, #v do parts[i] = canonical(v[i]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end

  local keys = {}
  for k, value in pairs(v) do
    if value ~= nil and value ~= NULL then keys[#keys + 1] = tostring(k) end
  end
  table.sort(keys)
  local parts = {}
  for i, k in ipairs(keys) do parts[i] = k .. "=" .. canonical(v[k]) end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function same(name, got, want)
  local g, w = canonical(got), canonical(want)
  check(name, g == w, "got  " .. g:sub(1, 400) .. "\n       want " .. w:sub(1, 400))
end

local function expand(v)
  if type(v) ~= "table" then return v end
  if type(v["$repeat"]) == "string" then return string.rep(v["$repeat"], v.n) end
  for k, inner in pairs(v) do v[k] = expand(inner) end
  return v
end

local function decoded(s) return s ~= nil and cjson.decode(s) or nil end

local f = assert(io.open(here .. "parity.json", "rb"))
local parity = expand(cjson.decode(f:read("*a")))
f:close()

-- What fetch's Headers makes of the pairs: lowercase names, repeats joined.
local function raw_headers(pairs_list)
  local raw = {}
  for _, pair in ipairs(pairs_list) do
    local name = string.lower(pair[1])
    if raw[name] == nil then raw[name] = pair[2]
    elseif type(raw[name]) == "table" then table.insert(raw[name], pair[2])
    else raw[name] = { raw[name], pair[2] } end
  end
  return raw
end

local function entries_of(pairs_list) return dna.header_entries(raw_headers(pairs_list)) end

-- ── Parity ───────────────────────────────────────────────────────────────────

local c = parity.constants
same("constants: ADAPTER_SET", dna.ADAPTER_SET, c.ADAPTER_SET)
same("constants: FORWARDED_HEADER_SET", dna.FORWARDED_HEADER_SET, c.FORWARDED_HEADER_SET)
same("constants: FORWARDED_HEADERS", dna.FORWARDED_HEADERS, c.FORWARDED_HEADERS)
same("constants: HEADER_LENGTH_CAPS", dna.HEADER_LENGTH_CAPS, c.HEADER_LENGTH_CAPS)
same("constants: NEVER_FORWARDED_HEADERS", dna.NEVER_FORWARDED_HEADERS, c.NEVER_FORWARDED_HEADERS)
same("constants: MCP_KEY_ARGUMENT_SCHEMA", dna.MCP_KEY_ARGUMENT_SCHEMA, c.MCP_KEY_ARGUMENT_SCHEMA)

for _, case in ipairs(parity.forwardAll) do
  same("forwardAll: " .. case.name, dna.forward_all(entries_of(case.headers), case.exclude, dna.HEADER_LENGTH_CAPS), case.out)
end

for _, case in ipairs(parity.withheld) do
  same("withheldOf: " .. case.name, dna.withheld_of(case.exclude, case.unlisted), case.out)
end

for _, case in ipairs(parity.exclusionList) do
  local raw = case.raw ~= NULL and case.raw or nil
  same("parseExclusionList: " .. tostring(raw) .. " " .. tostring(case.lowercase),
    dna.parse_exclusion_list(raw, case.lowercase), case.out)
end

for _, case in ipairs(parity.privateCacheControl) do
  local origin = case.origin ~= NULL and case.origin or nil
  same("privateCacheControl: " .. tostring(origin), dna.private_cache_control(origin), case.out)
end

for _, case in ipairs(parity.cookies) do
  same("cookiesOf: " .. case.header, dna.cookies_of(case.header), case.cookiesOf)
  same("readCookie session: " .. case.header, dna.read_cookie(case.header, "__Host-d3pay"), case.readSession)
  same("readCookie person: " .. case.header, dna.read_cookie(case.header, "__Host-d3person"), case.readPerson)
  if case.header ~= "" then same("stripOwnCookies: " .. case.header, dna.strip_own_cookies(case.header), case.stripOwn) end
end

for _, case in ipairs(parity.payParams) do
  same("stripPayParams: " .. case.url, dna.strip_pay_params(case.url), case.out)
end

-- A base64 credential is compared by the JSON inside it: both sides re-serialize.
local function lifted_view(lifted)
  local out = {}
  for name, value in pairs(lifted) do
    out[name] = name == "payment-signature" and (decoded(ngx.decode_base64(value)) or value) or value
  end
  return out
end

for _, case in ipairs(parity.mcp) do
  local body = case.body
  if case.blobBytes then body = body:gsub("@BLOB@", string.rep("x", case.blobBytes)) end
  local raw = raw_headers(case.headers)
  local get = function(name) return raw[name] end
  local carriage = dna.mcp_carriage_of(case.method, get, case.method == "GET" and "" or body, case.excluded)
  local label = "mcp: " .. case.name
  local rpc = carriage.rpc and { id = carriage.rpc.id, method = carriage.rpc.method, params = carriage.rpc.params } or nil
  same(label .. " (rpc)", rpc, case.rpc)
  same(label .. " (facts)", carriage.facts, case.facts)
  same(label .. " (lifted)", lifted_view(carriage.lifted), lifted_view(case.lifted))
  same(label .. " (origin body)", decoded(carriage.origin_body), case.originBody)
  same(label .. " (unreadable)", carriage.unreadable_credential, case.unreadableCredential)
  same(label .. " (why)", carriage.unreadable_reason, case.unreadableReason)
  same(label .. " (forwarded)", lifted_view(dna.lifted_payment_to_forward(raw, carriage.lifted)), lifted_view(case.forwarded))
end

local function headers_object(list)
  local out = {}
  for _, pair in ipairs(list) do out[string.lower(pair[1])] = pair[2] end
  return out
end

for _, case in ipairs(parity.answers) do
  local mode = dna.payment_edge_mode(tonumber(case.payment.status) or 502)
  local built = dna.build_payment_answer(case.payment, mode, case.rpcId)
  local label = "buildPaymentResponse: " .. case.name
  same(label .. " (status)", built.status, case.status)
  same(label .. " (headers)", headers_object(built.headers), case.headers)
  local want = case.body ~= NULL and case.body or nil
  same(label .. " (body)", decoded(built.body) or built.body, decoded(want) or want)
end

for _, case in ipairs(parity.results) do
  local meta = case.meta ~= NULL and case.meta or nil
  local method = case.method ~= NULL and case.method or nil
  local edits = dna.mcp_result_edits(method, meta, case.keyArgument)
  local rewritten = nil
  if edits and dna.is_json_type(case.contentType) then rewritten = dna.rewrite_result(case.body, edits.meta, edits.lists_tools) end
  same("withMcpResult: " .. case.name, decoded(rewritten), case.rewritten)
end

for _, case in ipairs(parity.exclusionOverflow) do
  same("exclusionOverflowWarning: " .. #case.exclude.headers .. "/" .. #case.exclude.cookies,
    dna.exclusion_overflow_warning(case.exclude), case.out)
end

for _, case in ipairs(parity.unreadableAnswers) do
  local built = dna.unreadable_call_answer(case.reason)
  same("unreadableCallResponse: " .. case.reason .. " (status)", built.status, case.status)
  same("unreadableCallResponse: " .. case.reason .. " (headers)", headers_object(built.headers), case.headers)
  same("unreadableCallResponse: " .. case.reason .. " (body)", decoded(built.body), decoded(case.body))
end

for _, case in ipairs(parity.edgeModes) do
  same("paymentEdgeMode: " .. case.status, dna.payment_edge_mode(case.status), case.out)
end

for _, case in ipairs(parity.recordableName) do
  same("recordableName: " .. case.name, dna.recordable_name(case.name), case.out)
end

for _, case in ipairs(parity.debugHeaders) do
  same("debugHeadersOf: " .. case.name, dna.debug_headers_of(entries_of(case.headers), case.excluded), case.out)
end

for _, case in ipairs(parity.settings) do
  local s = dna.settings(function(name) return case.env[name] end)
  local want = case.out
  -- The one deliberate difference (ADR 0090): the unpaid budget defaults to 150 ms.
  local timeout_set = case.env.DNA_TIMEOUT_MS or case.env.POLICY_TIMEOUT_MS
  if not (timeout_set and tonumber(timeout_set) and tonumber(timeout_set) > 0) then want.timeoutMs = 150 end
  same("readAdapterSettings: " .. case.name, {
    endpoint = s.endpoint, apiKey = s.api_key, failMode = s.fail_mode, timeoutMs = s.timeout_ms,
    paymentTimeoutMs = s.payment_timeout_ms, debugLogRawPayload = s.debug_log_raw_payload, exclude = s.exclude,
  }, want)
end

-- ── The port's own ───────────────────────────────────────────────────────────

-- Numbers: the shortest form that reads back as the same double.
for _, n in ipairs({ 0.30000000000000004, 0.1, 9007199254740991, -1.5e-7, 1e21, 123456789012345680, -0.0, 5 }) do
  check("json_encode keeps " .. string.format("%.17g", n), tonumber(dna.json_encode(n)) == n, dna.json_encode(n))
end
check("json_encode writes 0.1 short", dna.json_encode(0.1) == "0.1", dna.json_encode(0.1))
check("json_encode escapes controls, quotes and backslashes",
  dna.json_encode("a\1\n\"\\/") == '"a\\u0001\\n\\"\\\\/"', dna.json_encode("a\1\n\"\\/"))
check("json_encode keeps an empty array an array",
  dna.json_encode({ e = dna.array(), o = {} }) == '{"e":[],"o":{}}', dna.json_encode({ e = dna.array(), o = {} }))
check("json_decode drops a UTF-8 BOM", canonical(dna.json_decode("\239\187\191{\"a\":1}")) == canonical({ a = 1 }))

-- The header check is the last place before nginx's header table.
check("header_safe drops CRLF in a value", not dna.header_safe("x", "a\r\nb"))
check("header_safe drops a space in a name", not dna.header_safe("x y", "v"))
check("header_safe drops an empty value", not dna.header_safe("x", ""))
check("header_safe drops a value past 8192", not dna.header_safe("x", string.rep("v", 8193)))
check("header_safe drops a name past 64", not dna.header_safe(string.rep("n", 65), "v"))
check("header_safe drops a non-string", not dna.header_safe("x", 1))
check("header_safe keeps a token and printable value", dna.header_safe("payment-receipt", "abc; def=1"))

-- The handoff, as URLSearchParams reads it.
local handoff = string.rep("A", 22) .. "." .. string.rep("b", 43)
check("handoff read from the query", dna.handoff_from_args("x=1&d3pay_handoff=" .. handoff) == handoff)
check("handoff read under an escaped name", dna.handoff_from_args("d3pay%5Fhandoff=" .. handoff) == handoff)
check("a malformed handoff is none", dna.handoff_from_args("d3pay_handoff=" .. handoff .. "x") == nil)
check("only the first handoff counts", dna.handoff_from_args("d3pay_handoff=bad&d3pay_handoff=" .. handoff) == nil)

-- Payment presence picks the budget and the fail-closed answer.
check("a payment header under its cap pays", dna.presents_payment({ ["x-payment"] = "p" }, nil, {}))
check("a payment header past its cap does not", not dna.presents_payment({ ["x-payment"] = string.rep("p", 4097) }, nil, {}))
check("our session cookie pays", dna.presents_payment({ cookie = "__Host-d3pay=" .. string.rep("s", 43) }, nil, {}))
check("an oversized session cookie does not", not dna.presents_payment({ cookie = "__Host-d3pay=" .. string.rep("s", 65) }, nil, {}))
check("the person pass is not a payment", not dna.presents_payment({ cookie = "__Host-d3person=p" }, nil, {}))
check("a handoff on the URL pays", dna.presents_payment({}, "d3pay_handoff=" .. handoff, {}))
check("a payment lifted onto the payload pays", dna.presents_payment({}, nil, { ["payment-authorization"] = "Payment k" }))

-- After M.access raised: what is still read as paying, and so answered 502.
local keyed_call = '  {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{"dna_account_key":"k"}}}'
local no_body = { data = "" }
check("after an error the mirrored key pays", dna.may_pay_after_error({ ["mcp-param-dna-key"] = "k" }, nil, no_body))
check("after an error a session cookie with a space before its = pays",
  dna.may_pay_after_error({ cookie = "__Host-d3pay =" .. string.rep("s", 43) }, nil, no_body))
check("after an error an escaped handoff pays", dna.may_pay_after_error({}, "d3pay%5Fhandoff=" .. handoff, no_body))
check("after an error a key in a JSON body pays", dna.may_pay_after_error({}, nil, { data = keyed_call }))
check("after an error a key found in a body on disk pays",
  dna.may_pay_after_error({}, nil, { streamed = { names_credential = true } }))
check("after an error a document holding an example call does not",
  not dna.may_pay_after_error({}, nil, { data = "# Paying\n\n" .. keyed_call }))
check("after an error the person pass alone does not",
  not dna.may_pay_after_error({ cookie = "__Host-d3person=p" }, nil, no_body))
check("after an error an empty mirrored key does not",
  not dna.may_pay_after_error({ ["mcp-param-dna-key"] = "" }, nil, no_body))

check("an ACME challenge is never decided", dna.is_acme_challenge("/.well-known/acme-challenge/tok"))
check("other well-known paths are", not dna.is_acme_challenge("/.well-known/security.txt"))

-- The payload: revision 1 sends the fixed list, revision 3 everything but what it must not.
local req = {
  method = "POST", url = "/mcp?x=1", host = "site.example", ip = "203.0.113.7", secure = true, timestamp = 1,
  entries = entries_of({
    { "content-type", "application/json" }, { "user-agent", "agent/1" }, { "x-custom", "c" },
    { "cookie", "sid=1; __Host-d3pay=" .. string.rep("s", 43) }, { "authorization", "Bearer t" },
    { "content-digest", "sha-256=:forged=:" },
  }),
  body = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"a","_meta":{"dna.d3.com/key":"k"}}}',
}
local p1, m1 = dna.extract(req, { revision = 1, exclude = { headers = {}, cookies = {} } })
check("revision 1 forwards no unlisted header", p1.headers["x-custom"] == nil and p1.cookies == nil)
check("revision 1 reads no MCP call", m1 == nil and p1.mcp == nil)
check("the session cookie rides its own header", p1.headers["d3pay-session"] == string.rep("s", 43))
check("a claimed digest is replaced by the body's own", p1.headers["content-digest"] ~= "sha-256=:forged=:")

local p3, m3 = dna.extract(req, { revision = 3, exclude = { headers = { "x-custom" }, cookies = {} } })
check("revision 3 keeps an excluded header back", p3.headers["x-custom"] == nil)
check("revision 3 echoes the exclusion", p3.excluded and p3.excluded.headers[1] == "x-custom")
check("revision 3 never forwards authorization", p3.headers.authorization == nil)
check("revision 3 forwards the site's cookies, not ours", p3.cookies.sid == "1" and p3.cookies["__Host-d3pay"] == nil)
check("revision 3 lifts the call's key", p3.headers["payment-authorization"] == "Payment k")
check("revision 3 strips it from the origin's body", m3.origin_body and not m3.origin_body:find("dna.d3.com/key", 1, true))
check("revision 3 names the call", p3.mcp and p3.mcp.method == "tools/call" and p3.mcp.tool == "a")

-- nginx passes a GET's or HEAD's body on, so its digest is that body's, whatever was claimed.
local function digest_of(body)
  local sha = require("resty.sha256"):new()
  sha:update(body)
  return "sha-256=:" .. ngx.encode_base64(sha:final()) .. ":"
end
for _, method in ipairs({ "GET", "HEAD" }) do
  local claimed = dna.extract({
    method = method, url = "/x", host = "site.example", ip = "203.0.113.7", secure = true, timestamp = 1,
    entries = entries_of({ { "content-digest", digest_of("") } }), body = "smuggled",
  }, { revision = 3, exclude = { headers = {}, cookies = {} } })
  check(method .. ": the digest is the body's, not the empty one claimed", claimed.headers["content-digest"] == digest_of("smuggled"))

  local bare = dna.extract({
    method = method, url = "/x", host = "site.example", ip = "203.0.113.7", secure = true, timestamp = 1,
    entries = entries_of({}), body = "",
  }, { revision = 3, exclude = { headers = {}, cookies = {} } })
  check(method .. ": no body and no claim, no digest", bare.headers["content-digest"] == nil)
end

local p_ex = dna.extract(req, { revision = 3, exclude = { headers = { "payment-authorization" }, cookies = {} } })
check("an excluded payment header is not lifted onto the payload", p_ex.headers["payment-authorization"] == nil)

local p_dbg = dna.extract(req, { revision = 3, exclude = { headers = {}, cookies = {} }, debug = true })
check("debug headers never carry authorization or cookies",
  p_dbg.debugHeaders and p_dbg.debugHeaders.authorization == nil and p_dbg.debugHeaders.cookie == nil)

-- Our own answers.
local blocked = dna.block_answer({ ruleId = "r1", verdict = { tier = "claimed", identity = "bot" } }, "block")
check("a block is a 403 with its rule", blocked.status == 403 and cjson.decode(blocked.body).ruleId == "r1")
local unavailable = dna.payment_unavailable_answer()
check("payment unavailable is a 502 that is never cached", unavailable.status == 502 and headers_object(unavailable.headers)["cache-control"] == "no-store")
local too_large = dna.unreadable_call_answer()
check("an unreadable call naming a credential is a 413", too_large.status == 413 and too_large.mode == "fail-closed")

check("the report goes beside the decision endpoint", dna.report_url("https://edge-api.d3.com/v1/decision") == "https://edge-api.d3.com/v1/report")
check("the report keeps the endpoint's port", dna.report_url("http://127.0.0.1:9000/v1/decision") == "http://127.0.0.1:9000/v1/report")
check("the report path drops the query", dna.path_of("/a/b?x=1") == "/a/b")

dna.remember_key_argument("on.example", true)
dna.remember_key_argument("off.example", false)
check("the key argument is remembered per host", dna.key_argument_on("on.example") and not dna.key_argument_on("off.example"))
dna.remember_key_argument("on.example", false)
check("a later decision turns it off", not dna.key_argument_on("on.example"))

dna.save_state("ref1", { mode = "pass" })
check("state survives by its ref", dna.load_state("ref1").mode == "pass")
dna.forget_state("ref1")
check("state is forgotten after the log phase", dna.load_state("ref1") == nil and dna.load_state(nil) == nil)

-- A visitor's padded cookie name must cost linear time, not stall the worker.
local padded = "x" .. string.rep(" ", 100000) .. "y=1; " .. string.rep(" ", 100000) .. "=2"
local started = os.clock()
dna.cookies_of(padded)
dna.read_cookie(padded, "z")
dna.strip_own_cookies(padded)
dna.is_json_type(string.rep(" ", 100000) .. "x")
check("trim is linear on padded names", os.clock() - started < 0.1, string.format("%.3fs", os.clock() - started))
check("trim keeps what is between", dna.trim("  a b \t") == "a b" and dna.trim("   ") == "" and dna.trim("") == "")

-- cjson refuses what JSON.parse reads: such a call naming our credential is refused, not passed on.
local get_json = function(name) if name == "content-type" then return "application/json" end end
local lone = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","arguments":{"t":"cut \\ud83d here","dna_account_key":"k"}}}'
check("a lone surrogate call naming a credential is unreadable", dna.mcp_carriage_of("POST", get_json, lone, {}).unreadable_credential == true)
local lone_free = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","arguments":{"t":"cut \\ud83d here"}}}'
check("one naming none is passed on", dna.mcp_carriage_of("POST", get_json, lone_free, {}).unreadable_credential == false)
local deep = string.rep("[", 1001) .. string.rep("]", 1001)
local nested = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","x":' .. deep .. ',"_meta":{"dna.d3.com/key":"k"}}}'
check("a call nested past cjson's depth naming a credential is unreadable", dna.mcp_carriage_of("POST", get_json, nested, {}).unreadable_credential == true)
check("a streamed JSON call past the cap naming a credential is too large",
  dna.mcp_carriage_of("POST", get_json, nil, {}, { names_credential = true, too_large = true }).unreadable_reason == "too-large")
check("a streamed JSON-RPC body naming a credential is not one call",
  dna.mcp_carriage_of("POST", get_json, nil, {}, { names_credential = true, jsonrpc = true }).unreadable_reason == "not-one-call")
check("a streamed body that never says jsonrpc is left alone",
  dna.mcp_carriage_of("POST", get_json, nil, {}, { names_credential = true }).unreadable_credential == false)
check("a streamed call is never parsed", dna.mcp_carriage_of("POST", get_json, nil, {}, { names_credential = false }).rpc == nil)

-- nginx hides every variable without an `env` line, so a missing one is a setting silently ignored.
local main_conf = assert(io.open(here .. "../dna.main.conf", "rb")):read("*a")
for _, names in pairs(dna.SETTING_NAMES) do
  for _, name in ipairs(names) do
    check("dna.main.conf has env " .. name, main_conf:find("\nenv " .. name .. ";", 1, true) ~= nil)
  end
end

print(string.format("%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
