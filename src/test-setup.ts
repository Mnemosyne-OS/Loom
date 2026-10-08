/**
 * test-setup — the DOM matchers, registered the way this workspace can take.
 *
 * 🪤 NOT `@testing-library/jest-dom/vitest`: that entry point is written for
 * vitest 2/3 and sets `testPath` on the expect state, which is getter-only in
 * the vitest 1.6 this workspace pins. It fails during SETUP, so every test file
 * dies before a single assertion runs (measured on Oikos: 76 tests, zero ever
 * green). The `/matchers` entry is version-neutral.
 */
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);
