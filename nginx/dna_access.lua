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

if dna then
  local ok, err = pcall(dna.access, ngx.ctx.dna_revision or dna.ADAPTER_SET)
  if ok then return end
  dna.log_every("access error", 10, ngx.ERR, "dna: the access phase failed, so this request fails open: ", err)
end

-- Unloaded or failed, the origin still gets no visitor's verdict and no payment
-- header, and a request that pays is answered 502, never served free.
local paying = false
for name, value in pairs(ngx.req.get_headers(0, true)) do
  local key = string.lower((string.gsub(name, "_", "-")))
  if key == "payment-signature" or key == "x-payment" or key == "payment-authorization" or key == "d3pay-session" then
    paying = paying or value ~= ""
    ngx.req.clear_header(name)
  elseif key == "x-d3-tier" or key == "x-d3-identity" or key == "d3pay-person" or key == "mcp-param-dna-key" then
    ngx.req.clear_header(name)
  end
end
paying = paying or string.find(ngx.var.http_cookie or "", "__Host-d3pay=", 1, true) ~= nil
  or string.find(ngx.var.args or "", "d3pay_handoff=", 1, true) ~= nil

if paying then
  ngx.status = 502
  ngx.header["Content-Type"] = "application/json; charset=utf-8"
  ngx.header["Cache-Control"] = "no-store"
  ngx.header["x-d3-edge"] = "fail-closed"
  ngx.print('{"error":"payment_unavailable"}')
  return ngx.exit(ngx.HTTP_OK)
end
ngx.header["x-d3-edge"] = "fail-open"
