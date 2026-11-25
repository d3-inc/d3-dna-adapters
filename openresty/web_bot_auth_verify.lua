-- web_bot_auth_verify.lua: DNA for OpenResty, as installed before dna.server.conf.
-- That install runs only the access phase, so it declares revision 1.
ngx.ctx.dna_revision = 1
local entry = package.loaded["d3_dna_access"]
if entry == nil then
  local dir = string.match(debug.getinfo(1, "S").source, "^@(.*/)") or "./"
  entry = assert(loadfile(dir .. "dna_access.lua"))
  package.loaded["d3_dna_access"] = entry
end

return entry()
