-- dna_access.lua: DNA for OpenResty, the access phase. dna.server.conf runs it,
-- declaring revision 3; web_bot_auth_verify.lua runs it at revision 1.
local dna = package.loaded["d3_dna"]
if dna == nil then
  local dir = string.match(debug.getinfo(1, "S").source, "^@(.*/)") or "./"
  local ok, loaded = pcall(dofile, dir .. "dna.lua")
  -- Kept either way, so a missing library is neither retried nor logged on every request.
  package.loaded["d3_dna"] = ok and loaded or false
  if not ok then ngx.log(ngx.ERR, "dna: cannot load dna.lua, so DNA is off until nginx reloads: ", loaded) end
  dna = package.loaded["d3_dna"]
end

local function refuse()
  ngx.status = 502
  ngx.header["Content-Type"] = "application/json; charset=utf-8"
  ngx.header["Cache-Control"] = "no-store"
  ngx.header["x-d3-edge"] = "fail-closed"
  ngx.print('{"error":"payment_unavailable"}')
  return ngx.exit(ngx.HTTP_OK)
end

if dna then
  local ok, err = pcall(dna.access, ngx.ctx.dna_revision or dna.ADAPTER_SET)
  if ok then return end
  dna.log_every("access error", 10, ngx.ERR, "dna: the access phase failed, so this request fails open unless it pays: ", err)

  local contained, paying = pcall(dna.contain_access_error)
  if contained then
    if paying then return refuse() end
    ngx.header["x-d3-edge"] = "fail-open"
    return
  end
  dna.log_every("contain error", 10, ngx.ERR, "dna: cannot strip this request, so anything of ours on it is refused: ", paying)
end

-- Nothing loaded can read a cookie, a query or a body here, so our headers go by
-- name and any other credential of ours is refused rather than passed on.
local PAYING_HEADERS = {
  ["payment-signature"] = true, ["x-payment"] = true, ["payment-authorization"] = true,
  ["d3pay-session"] = true, ["mcp-param-dna-key"] = true,
}
local OTHER_HEADERS = { ["x-d3-tier"] = true, ["x-d3-identity"] = true, ["d3pay-person"] = true }
-- As a call's JSON spells them, PHP's escaped `\/` included.
local BODY_KEYS = { "dna_account_key", "dna.d3.com/key", "dna.d3.com\\/key", "x402/payment", "x402\\/payment" }

local function names_key(s)
  for _, key in ipairs(BODY_KEYS) do
    if string.find(s, key, 1, true) then return true end
  end
  return false
end

local function body_names_key()
  ngx.req.read_body()
  local data = ngx.req.get_body_data()
  if data then return names_key(data) end

  local file = ngx.req.get_body_file()
  local f = file and io.open(file, "rb")
  if not f then return false end
  -- The previous chunk's tail keeps a key split across two chunks findable.
  local tail, found = "", false
  local chunk = f:read(65536)
  while chunk and not found do
    found = names_key(tail .. chunk)
    tail = string.sub(chunk, -16)
    chunk = f:read(65536)
  end
  f:close()
  return found
end

local ours = false
for name, value in pairs(ngx.req.get_headers(0, true)) do
  local key = string.lower((string.gsub(name, "_", "-")))
  if PAYING_HEADERS[key] then
    ours = ours or value ~= ""
    ngx.req.clear_header(name)
  elseif OTHER_HEADERS[key] then
    ngx.req.clear_header(name)
  end
end
-- Matched loosely, so `__Host-d3pay =x` and `d3pay%5Fhandoff` count too.
ours = ours
  or string.find(ngx.var.http_cookie or "", "__Host-d3", 1, true) ~= nil
  or string.find(ngx.unescape_uri(ngx.var.args or ""), "d3pay_", 1, true) ~= nil
  or body_names_key()

if ours then return refuse() end
ngx.header["x-d3-edge"] = "fail-open"
