# limun

A JavaScript runtime that uses the web standard API as its primary surface,
keeping Node.js as a guest — never the host.

The goal is a cleaner JS runtime space. Web-standard APIs by default because
they're a good standard, not for browser compatibility (that's a side effect).
Node.js compatibility is an external package concern, never ambient, never in
the runtime's globals.

See [MISSION.md](./MISSION.md) for the why and the API philosophy.

---

BTW im using LLMs heavyly for this. i just want it to exists rn. i dont have time to work on it myself.
I just wanna make sure of the DX.
Later if it looks good, it can be rewritten cleanly knowing the shape we want.
