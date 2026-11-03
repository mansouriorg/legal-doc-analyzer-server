// Tells the server that the browser has left, so that work nobody waits for any
// more can be stopped.
//
// A browser that stops waiting (the person clicked "Stop waiting", closed the
// tab or left the page) closes its connection to the server. Node then closes
// the response of that request before it was sent. This file turns that into an
// AbortSignal. The controller of the questions hands the signal to the call to
// the AI service (see ask.controller.ts).

// The part of the response of Express that is used here. A test can use a small
// stand-in that has the same four members.
export interface WatchedResponse {
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

export interface ClientWatch {
  // Aborted when the connection closes before the answer was sent.
  readonly signal: AbortSignal;
  // Stops watching. Call it when the work is done, whatever the outcome, so
  // that nothing is aborted later and no listener stays on the response.
  stop(): void;
}

// Without a response there is nothing to watch: the signal is never aborted.
export function watchClient(
  response: WatchedResponse | undefined,
): ClientWatch {
  const controller = new AbortController();
  if (response === undefined) {
    return { signal: controller.signal, stop: () => undefined };
  }

  // A response also closes after it was sent completely. Then no work is left
  // to cancel.
  const onClose = (): void => {
    if (response.writableFinished === false) {
      controller.abort();
    }
  };
  if (response.destroyed && response.writableFinished === false) {
    // The browser left before the watching started, so the event has passed.
    controller.abort();
  } else {
    response.once('close', onClose);
  }

  return {
    signal: controller.signal,
    stop: () => {
      response.removeListener('close', onClose);
    },
  };
}
