importScripts("pyxis-runtime://sandbox/pyodide/pyodide.js");
let python;
self.onmessage = async (event) => {
  const data = event.data;
  if (data.type === "init") {
    try {
      python = await loadPyodide({ indexURL: "pyxis-runtime://sandbox/pyodide/", packageBaseUrl: "pyxis-runtime://sandbox/pyodide/" });
      if (data.buffer) python.setInterruptBuffer(data.buffer);
      await python.loadPackage(["sympy", "mpmath"]);
      python.runPython(await (await fetch("pyxis-runtime://sandbox/symbolic.py")).text());
      postMessage({ type: "ready" });
    } catch (error) { postMessage({ type: "load-error", error: String(error) }); }
  } else if (data.type === "run") {
    python.globals.set("_pyxis_claim", JSON.stringify(data.payload));
    try { postMessage({ type: "done", id: data.id, result: JSON.parse(python.runPython("check_claim(_pyxis_claim)")) }); }
    catch { postMessage({ type: "done", id: data.id, result: { state: "none", reason: "check-error" } }); }
    finally { python.globals.delete("_pyxis_claim"); }
  }
};
