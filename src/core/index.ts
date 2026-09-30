type ParentPort = {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parent = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;

if (!parent) {
  console.error("pyxis-core: parentPort missing");
}

parent?.on("message", (event) => {
  const data = event.data;
  if (
    data &&
    typeof data === "object" &&
    "type" in data &&
    data.type === "ping"
  ) {
    parent.postMessage({ type: "pong" });
  }
});

console.log("pyxis-core ready");
