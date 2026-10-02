(() => {
const send = self.postMessage.bind(self);
importScripts("pyxis-runtime://sandbox/pyodide/pyodide.js");
let python;
let currentId = 0;
self.onmessage = async (event) => {
  const data = event.data;
  if (data.type === "init") {
    try {
      python = await loadPyodide({ indexURL: "pyxis-runtime://sandbox/pyodide/", packageBaseUrl: "pyxis-runtime://sandbox/pyodide/", stdout: (text) => send({ type: "output", id: currentId, stream: "stdout", text: text + "\n" }), stderr: (text) => send({ type: "output", id: currentId, stream: "stderr", text: text + "\n" }) });
      if (data.buffer) python.setInterruptBuffer(data.buffer);
      await python.loadPackage(["sympy", "mpmath", "numpy", "matplotlib"]);
      python.registerJsModule("_pyxis_output", { image: (image) => send({ type: "image", id: currentId, image }) });
      python.runPython(`import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport io, base64\nfrom _pyxis_output import image as _pyxis_image\ndef _pyxis_show(*args, **kwargs):\n    for number in plt.get_fignums()[:10]:\n        data = io.BytesIO()\n        plt.figure(number).savefig(data, format='png', dpi=120)\n        _pyxis_image('data:image/png;base64,' + base64.b64encode(data.getvalue()).decode('ascii'))\n    plt.close('all')\nplt.show = _pyxis_show`);
      send({ type: "ready" });
    } catch (error) { send({ type: "load-error", error: String(error) }); }
  } else if (data.type === "run") {
    currentId = data.id;
    try {
      const value = await python.runPythonAsync(String(data.payload));
      if (value !== undefined && value !== null) send({ type: "output", id: currentId, stream: "stdout", text: String(value) + "\n" });
      value?.destroy?.();
    } catch (error) { send({ type: "output", id: currentId, stream: "stderr", text: String(error) + "\n" }); }
    send({ type: "done", id: currentId, token: data.token });
  }
};

})();
