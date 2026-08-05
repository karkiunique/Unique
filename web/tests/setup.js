import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount everything between tests so the jsdom document does not leak
// rendered trees (or pending effects) into the next test.
afterEach(() => {
  cleanup();
});
