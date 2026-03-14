/**
 * Fake Lark client that records all API calls with controllable Promises.
 * Used in integration tests to verify card PATCH sequences without hitting real Feishu API.
 */

export interface RecordedCall {
  method: 'updateMessage' | 'sendUserMessage' | 'replyMessage' | 'getChatInfo';
  args: any[];
  resolve: (value?: any) => void;
  reject: (err: Error) => void;
  promise: Promise<any>;
}

export class FakeLarkClient {
  calls: RecordedCall[] = [];

  /** All updateMessage (PATCH) calls */
  get patches(): RecordedCall[] {
    return this.calls.filter(c => c.method === 'updateMessage');
  }

  /** All sendUserMessage (DM) calls */
  get dms(): RecordedCall[] {
    return this.calls.filter(c => c.method === 'sendUserMessage');
  }

  /** Create a controllable mock function for a given method */
  createMock(method: RecordedCall['method']) {
    return (...args: any[]) => {
      let resolve!: (value?: any) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<any>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.calls.push({ method, args, resolve, reject, promise });
      return promise;
    };
  }

  /** Resolve the Nth call of a method (0-indexed) */
  resolveCall(method: RecordedCall['method'], index = 0, value?: any): void {
    const methodCalls = this.calls.filter(c => c.method === method);
    if (index >= methodCalls.length) {
      throw new Error(`No ${method} call at index ${index} (have ${methodCalls.length})`);
    }
    methodCalls[index].resolve(value);
  }

  /** Resolve all pending calls of a method */
  resolveAll(method: RecordedCall['method'], value?: any): void {
    for (const c of this.calls.filter(c => c.method === method)) {
      c.resolve(value);
    }
  }

  /** Reset all recorded calls */
  reset(): void {
    this.calls.length = 0;
  }
}
