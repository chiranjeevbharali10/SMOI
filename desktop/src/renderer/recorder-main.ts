/**
 * The hidden recorder page (FR-03.02, FR-03.07, NFR-04.03). It opens the microphone only when the
 * main process says the user pressed the voice shortcut, records one command, and closes the
 * microphone as soon as recording stops or is cancelled.
 *
 * Recording stops by itself 1.5 s after the user stops speaking, after 8 s if nothing is said,
 * or after 30 s at most. Audio goes to the main process once, as WebM/Opus bytes; nothing is
 * saved here.
 */
const api = window.smoiRecorder;

const SPEECH_RMS = 0.02;
const SILENCE_AFTER_SPEECH_MS = 1500;
const NOTHING_SAID_MS = 8000;

interface Take {
  stream: MediaStream;
  recorder: MediaRecorder;
  context: AudioContext;
  timer: number;
  cancelled: boolean;
}

let take: Take | null = null;

function release(t: Take) {
  window.clearInterval(t.timer);
  t.stream.getTracks().forEach((track) => track.stop()); // the microphone is off from here
  void t.context.close();
}

function stop(t: Take) {
  window.clearInterval(t.timer);
  if (t.recorder.state !== 'inactive') t.recorder.stop();
  else release(t);
}

api.onStart(async ({ maxMs }) => {
  if (take) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (e) {
    api.failed(e instanceof DOMException ? e.name : 'Error');
    return;
  }
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const chunks: Blob[] = [];
  const started = performance.now();
  let lastSpeech: number | null = null;

  const t: Take = { stream, recorder, context, timer: 0, cancelled: false };
  take = t;
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    release(t);
    take = null;
    if (t.cancelled) return;
    if (lastSpeech === null) {
      api.nothingHeard();
      return;
    }
    api.done(new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer()));
  };
  t.timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const now = performance.now();
    if (Math.sqrt(sum / samples.length) > SPEECH_RMS) lastSpeech = now;
    const quietAfterSpeech = lastSpeech !== null && now - lastSpeech > SILENCE_AFTER_SPEECH_MS;
    const nothingSaid = lastSpeech === null && now - started > NOTHING_SAID_MS;
    if (quietAfterSpeech || nothingSaid || now - started > maxMs) stop(t);
  }, 100);
  recorder.start(250);
  api.started();
});

api.onCancel(() => {
  if (!take) return;
  take.cancelled = true;
  take.stream.getTracks().forEach((track) => track.stop());
  stop(take);
});

api.ready();
