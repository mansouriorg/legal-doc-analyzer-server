import { EventEmitter } from 'node:events';
import { watchClient, type WatchedResponse } from './client-gone';

// A response that the test can close, like the response of a request whose
// browser has left.
class FakeResponse extends EventEmitter implements WatchedResponse {
  writableFinished = false;
  destroyed = false;

  // The browser drops the connection before the answer was sent.
  browserLeaves(): void {
    this.destroyed = true;
    this.emit('close');
  }

  // The answer was sent completely, and then the response closes.
  answerSent(): void {
    this.writableFinished = true;
    this.destroyed = true;
    this.emit('close');
  }
}

describe('watchClient', () => {
  it('is not aborted while the connection is open', () => {
    const watch = watchClient(new FakeResponse());
    expect(watch.signal.aborted).toBe(false);
  });

  it('is aborted when the connection closes before the answer was sent', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    response.browserLeaves();
    expect(watch.signal.aborted).toBe(true);
  });

  it('is not aborted when the response closes after the answer was sent completely', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    response.answerSent();
    expect(watch.signal.aborted).toBe(false);
  });

  it('is aborted at once when the browser left before the watching started', () => {
    const response = new FakeResponse();
    response.browserLeaves();
    const watch = watchClient(response);
    expect(watch.signal.aborted).toBe(true);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('is not aborted when the response was already closed after a complete answer', () => {
    const response = new FakeResponse();
    response.answerSent();
    const watch = watchClient(response);
    expect(watch.signal.aborted).toBe(false);
  });

  it('listens once, and stops listening when it is told to stop', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    expect(response.listenerCount('close')).toBe(1);
    watch.stop();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('is not aborted by a connection that closes after it was told to stop', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    watch.stop();
    response.browserLeaves();
    expect(watch.signal.aborted).toBe(false);
  });

  it('can be told to stop twice', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    watch.stop();
    watch.stop();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('tells its listeners once, also when the response closes twice', () => {
    const response = new FakeResponse();
    const watch = watchClient(response);
    let told = 0;
    watch.signal.addEventListener('abort', () => {
      told += 1;
    });
    response.browserLeaves();
    response.browserLeaves();
    expect(told).toBe(1);
  });

  it('never aborts without a response, and can be told to stop', () => {
    const watch = watchClient(undefined);
    expect(watch.signal.aborted).toBe(false);
    watch.stop();
    expect(watch.signal.aborted).toBe(false);
  });

  it('watches each response on its own', () => {
    const first = new FakeResponse();
    const second = new FakeResponse();
    const watchFirst = watchClient(first);
    const watchSecond = watchClient(second);
    first.browserLeaves();
    expect(watchFirst.signal.aborted).toBe(true);
    expect(watchSecond.signal.aborted).toBe(false);
  });
});
