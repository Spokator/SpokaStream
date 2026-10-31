// Reçoit les images du moteur natif et les pousse dans la piste vidéo, hors du fil de l'interface.

const HEADER_BYTES = 16;
/** Au-delà, l'encodeur prend du retard : mieux vaut sauter une image que d'accumuler de la latence. */
const MAX_PENDING = 2;

const scope = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (message: unknown) => void };

scope.onmessage = event => {
  const { writable, url } = event.data as { writable: WritableStream<VideoFrame>; url: string };
  const writer = writable.getWriter();
  let pending = 0;
  let width = 0;
  let height = 0;

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.onmessage = message => {
    const data = message.data as ArrayBuffer;
    const header = new DataView(data);
    const frameWidth = header.getInt32(0, true);
    const frameHeight = header.getInt32(4, true);
    if (frameWidth !== width || frameHeight !== height) {
      width = frameWidth;
      height = frameHeight;
      scope.postMessage({ type: "size", width, height });
    }
    if (pending >= MAX_PENDING) return;
    const frame = new VideoFrame(new Uint8Array(data, HEADER_BYTES), {
      format: "NV12",
      codedWidth: width,
      codedHeight: height,
      timestamp: Number(header.getBigInt64(8, true)),
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
      transfer: [data],
    } as VideoFrameBufferInit);
    pending++;
    void writer.write(frame).then(
      () => pending--,
      () => pending--,
    );
  };
  socket.onclose = () => scope.postMessage({ type: "closed" });
};
