import { describe, it, expect } from 'vitest';

import { httpError, safeMessage } from '../src/lib/httpError.js';

describe('httpError', () => {
  it('builds an Error carrying a status and an expose flag', () => {
    const err = httpError(400, 'Gmail is not connected');

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.expose).toBe(true);
    expect(err.message).toBe('Gmail is not connected');
  });
});

describe('safeMessage', () => {
  it('returns our own 4xx messages', () => {
    expect(safeMessage(httpError(400, 'Missing OAuth code'), 'fallback')).toBe('Missing OAuth code');
  });

  it('hides messages on 5xx even when they are ours', () => {
    expect(safeMessage(httpError(500, 'Could not store the Gmail connection'), 'fallback')).toBe(
      'fallback'
    );
  });

  it('hides third-party SDK messages that happen to carry a status', () => {
    const sdkError = new Error('400 invalid_request_error: prompt too long');
    sdkError.status = 400;

    expect(safeMessage(sdkError, 'fallback')).toBe('fallback');
  });

  it('hides messages from plain errors', () => {
    expect(safeMessage(new Error('ECONNRESET at gmail.googleapis.com'), 'fallback')).toBe('fallback');
    expect(safeMessage(undefined, 'fallback')).toBe('fallback');
  });
});
