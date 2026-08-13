import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The backfill prompt for the sign-off name (CLAUDE.md, Decisions 2026-08-13).
 *
 * Accounts created before migration 006 have no name, and one cannot be invented
 * for them. They are asked on next login — and the asking must never block: not
 * the page, not a draft, not a send. Every failure path here renders nothing.
 */

const { apiGet, apiPatch } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: apiPatch },
  apiFetch: vi.fn()
}));

const { default: SignoffNamePrompt } = await import('../src/components/SignoffNamePrompt.jsx');

const NAME = 'Unique Karki';
const PROMPT = /Every email we draft signs off with your name/;

function meResponse(fullName) {
  return { user: { id: 'user-1', email: 'ana@corp.example', full_name: fullName } };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPatch.mockResolvedValue({ user: { id: 'user-1', full_name: NAME } });
});

describe('SignoffNamePrompt', () => {
  it('asks a pre-006 account for its name', async () => {
    apiGet.mockResolvedValue(meResponse(null));

    render(<SignoffNamePrompt />);

    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/me');
  });

  it('saves the name and gets out of the way', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    const user = userEvent.setup();

    render(<SignoffNamePrompt />);
    await screen.findByText(PROMPT);

    await user.type(screen.getByLabelText('Your full name'), `  ${NAME}  `);
    await user.click(screen.getByRole('button', { name: /Save my name/ }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/me', { full_name: NAME }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).not.toBeInTheDocument());
  });

  it('says nothing to an account that already has a name', async () => {
    apiGet.mockResolvedValue(meResponse(NAME));

    render(<SignoffNamePrompt />);

    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });

  /** Not knowing is a reason to stay quiet, never to interrupt. */
  it('renders nothing at all when the lookup fails', async () => {
    apiGet.mockRejectedValue(Object.assign(new Error('Not signed in'), { status: 401 }));

    const { container } = render(<SignoffNamePrompt />);

    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses a blank name without calling the server', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    const user = userEvent.setup();

    render(<SignoffNamePrompt />);
    await screen.findByText(PROMPT);

    await user.type(screen.getByLabelText('Your full name'), '   ');
    await user.click(screen.getByRole('button', { name: /Save my name/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the name you sign emails');
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('keeps the prompt open and explains itself when the save fails', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    apiPatch.mockRejectedValue(new Error('Could not save your name'));
    const user = userEvent.setup();

    render(<SignoffNamePrompt />);
    await screen.findByText(PROMPT);

    await user.type(screen.getByLabelText('Your full name'), NAME);
    await user.click(screen.getByRole('button', { name: /Save my name/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your name');
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });
});
