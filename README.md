# limun

A JavaScript runtime that uses the web standard API as its primary surface,
keeping as an isolated compat interface and aot only Node.js.

Uses ESM, but supports CommonJS compat features, interfaces and aot.

The goal is a cleaner JS runtime space. Web-standard APIs by default because
they're a good standard, not for browser compatibility (that's a side effect).
Node.js compatibility is isolated from the main interface.

Node.js and CommonJS compat aot only applied for imported packages with package.json.

See [MISSION.md](./MISSION.md) for the why and the API philosophy.

---

BTW im using LLMs heavyly for this. i just want it to exists rn. i dont have time to work on it myself.
I just wanna make sure of the DX.
Later if it looks good, it can be rewritten cleanly knowing the shape we want.
