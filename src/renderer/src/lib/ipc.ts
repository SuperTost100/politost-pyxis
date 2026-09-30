import type {
  BroadcastName,
  BroadcastValue,
  RequestInput,
  RequestName,
  RequestOutput,
} from "@shared/ipc";

export function invoke<N extends RequestName>(
  name: N,
  input: RequestInput<N>,
): Promise<RequestOutput<N>> {
  return window.pyxis.invoke(name, input) as Promise<RequestOutput<N>>;
}

export function onBroadcast<N extends BroadcastName>(
  name: N,
  cb: (value: BroadcastValue<N>) => void,
): () => void {
  return window.pyxis.on(name, (value) => cb(value as BroadcastValue<N>));
}
