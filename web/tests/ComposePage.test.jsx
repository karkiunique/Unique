import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: ComposePage } = await import('../src/pages/ComposePage.jsx');

const TO = 'sam@corp.com';
const GOAL = 'ask for 15 minutes';
const SUBJECT = 'about the launch';
const BODY =
  "hey Sam\n\nworth 15 minutes next week?\n\nthanks,\nAna\n\nDon't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)";

function draft(overrides = {}) {
  return { subject: SUBJECT, body: BODY, fidelityScore: 92, violations: [], ...overrides };
}

/** Everything /send/generate needs, filled in. */
async function fillBrief(user) {
  await user.type(screen.getByLabelText('Recipient email'), TO);
  await user.type(screen.getByLabelText('What should this email do?'), GOAL);
}

function sendCalls() {
  return apiPost.mock.calls.filter(([path]) => path === '/send');
}

beforeEach(() => {
  apiPost.mockReset();
});

describe('ComposePage — generating', () => {
  it('calls /send/generate and fills the subject and body fields', async () => {
    apiPost.mockResolvedValue(draft());
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.type(screen.getByLabelText('Recipient name'), 'Sam');
    await user.type(screen.getByLabelText('Company'), 'Corp');
    await user.click(screen.getByRole('button', { name: 'Generate in my voice' }));

    expect(await screen.findByDisplayValue(SUBJECT)).toBeInTheDocument();
    expect(screen.getByLabelText('Email body')).toHaveValue(BODY);
    expect(apiPost).toHaveBeenCalledWith('/send/generate', {
      to: TO,
      recipientName: 'Sam',
      company: 'Corp',
      goal: GOAL
    });
  });

  it('renders a visible warning when the fidelity score is under 80', async () => {
    apiPost.mockResolvedValue(
      draft({ fidelityScore: 61, violations: ['greeting is not one they use'] })
    );
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', { name: 'Generate in my voice' }));

    expect(await screen.findByText(/Voice fidelity 61 \/ 100/)).toBeInTheDocument();
    expect(container.querySelector('.error')).toHaveTextContent(/does not sound enough like you/i);
    expect(screen.getByText('greeting is not one they use')).toBeInTheDocument();
  });

  it('does not warn when the fidelity score clears the bar', async () => {
    apiPost.mockResolvedValue(draft({ fidelityScore: 92 }));
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', { name: 'Generate in my voice' }));

    expect(await screen.findByText(/Voice fidelity 92 \/ 100/)).toBeInTheDocument();
    expect(container.querySelector('.error')).toBeNull();
  });

  it('renders the server error when drafting fails', async () => {
    const err = new Error('No voice profile yet — build one before generating');
    err.status = 400;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', { name: 'Generate in my voice' }));

    expect(
      await screen.findByText('No voice profile yet — build one before generating')
    ).toBeInTheDocument();
  });
});

describe('ComposePage — reaching the confirmation step', () => {
  it('disables "Review and send" until recipient, subject and body are filled', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    const review = screen.getByRole('button', { name: 'Review and send' });

    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText('Recipient email'), TO);
    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    expect(review).toBeEnabled();
  });

  it('lets a hand-written email reach the confirm step without generating', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    await user.type(screen.getByLabelText('Recipient email'), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    await user.click(screen.getByRole('button', { name: 'Review and send' }));

    expect(await screen.findByText('Send this email?')).toBeInTheDocument();
    // Generation is optional: nothing was drafted for us.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('never calls /send itself — only the confirm dialog does', async () => {
    apiPost.mockResolvedValue(draft());
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', { name: 'Generate in my voice' }));
    await screen.findByDisplayValue(SUBJECT);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));

    expect(await screen.findByText('Send this email?')).toBeInTheDocument();
    // Opening the confirmation is not sending. Only the Send click posts /send.
    expect(sendCalls()).toHaveLength(0);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][0]).toBe('/send/generate');
  });

  it('Cancel on the confirm step returns to editing without sending', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    await user.type(screen.getByLabelText('Recipient email'), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByLabelText('Email body')).toHaveValue('hey Sam');
    expect(sendCalls()).toHaveLength(0);
  });
});
