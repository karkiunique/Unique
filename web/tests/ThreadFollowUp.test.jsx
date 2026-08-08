import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet, apiPost, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  navigateTo: vi.fn()
}));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

// Stubbed so nothing in the tree can actually navigate.
vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  getQueryParam: () => null
}));

const { default: ThreadsPage } = await import('../src/pages/ThreadsPage.jsx');

const THREAD_ID = 't-1';
const SUBJECT = 'about the launch';
const RECIPIENT = 'sam@corp.com';
const LAST_MESSAGE_ID = '<m2@mail.example>';

/**
 * Deliberately ragged — leading and trailing whitespace and a "blank" line that
 * is really spaces. What the user reads is what leaves their Gmail, so any
 * tidying between the screen and the payload has to fail here rather than pass
 * unnoticed.
 */
const FOLLOW_UP_BODY = [
  'Sam - circling back on this.',
  '   ',
  'still worth 15 minutes?',
  '',
  'thanks,',
  'Ana'
].join('\n');

const THREADS = [
  {
    threadId: THREAD_ID,
    subject: SUBJECT,
    to: RECIPIENT,
    sentAt: '2026-08-01T09:00:00.000Z',
    replied: true,
    replyCount: 1
  }
];

const DETAIL = {
  threadId: THREAD_ID,
  messages: [
    {
      id: 'm-1',
      messageId: '<m1@mail.example>',
      from: 'Ana <ana@desk.com>',
      to: 'Sam <sam@corp.com>',
      subject: SUBJECT,
      sentAt: '2026-08-01T09:00:00.000Z',
      fromSelf: true,
      body: 'hey Sam\n\nsaw the launch go out. worth 15 minutes next week?'
    },
    {
      id: 'm-2',
      messageId: LAST_MESSAGE_ID,
      from: 'Sam <sam@corp.com>',
      to: 'Ana <ana@desk.com>',
      subject: 'Re: about the launch',
      sentAt: '2026-08-02T11:30:00.000Z',
      fromSelf: false,
      body: 'sure — how about Thursday?'
    }
  ]
};

const FOLLOW_UP = { name: 'Follow up' };
const REVIEW = { name: 'Review & send' };
const SEND = { name: 'Send from my Gmail' };
const CANCEL = { name: /keep editing/i };

function postedPaths() {
  return apiPost.mock.calls.map(([path]) => path);
}

function detailRequests() {
  return apiGet.mock.calls.filter(([path]) => path === `/threads/${THREAD_ID}`);
}

/** Open the thread, open the follow-up composer, and write a body. */
async function writeFollowUp(user, body = FOLLOW_UP_BODY) {
  await screen.findByText(SUBJECT);
  await user.click(screen.getByText(SUBJECT));
  await screen.findByRole('button', FOLLOW_UP);
  await user.click(screen.getByRole('button', FOLLOW_UP));
  await user.type(screen.getByLabelText('Follow-up body'), body);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();
  apiGet.mockImplementation((path) =>
    path.startsWith('/threads/') ? Promise.resolve(DETAIL) : Promise.resolve({ threads: THREADS })
  );
  apiPost.mockResolvedValue({ messageId: 'msg-9', threadId: THREAD_ID });
});

describe('Follow-up — it goes through the shared confirmation dialog', () => {
  it('opens ConfirmSendDialog, not a confirmation of its own', async () => {
    const user = userEvent.setup();

    const { container } = render(<ThreadsPage />);
    await writeFollowUp(user);
    await user.click(screen.getByRole('button', REVIEW));

    // The same dialog the compose flow uses, identified by its own contract.
    const dialog = await screen.findByRole('dialog', { name: 'Confirm send' });
    expect(dialog).toHaveClass('modal-sheet');
    expect(screen.getByText('Send this letter?')).toBeInTheDocument();
    expect(screen.getByRole('button', SEND)).toBeInTheDocument();
    expect(container.querySelector('.confirm-to').textContent).toBe(RECIPIENT);
    expect(container.querySelector('.confirm-subject').textContent).toBe(SUBJECT);
    expect(container.querySelector('.confirm-body').textContent).toBe(FOLLOW_UP_BODY);
  });

  it('does NOT call /send when the dialog opens — only the approve click sends', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await writeFollowUp(user);

    expect(postedPaths()).toEqual([]);

    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');

    // Reaching the final read is not sending.
    expect(postedPaths()).toEqual([]);

    await user.click(screen.getByRole('button', SEND));

    await waitFor(() => expect(postedPaths()).toEqual(['/send']));
  });

  it('sends the thread ids, the confirmation, and the body exactly as displayed', async () => {
    const user = userEvent.setup();

    const { container } = render(<ThreadsPage />);
    await writeFollowUp(user);
    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');

    const shownTo = container.querySelector('.confirm-to').textContent;
    const shownSubject = container.querySelector('.confirm-subject').textContent;
    const shownBody = container.querySelector('.confirm-body').textContent;

    await user.click(screen.getByRole('button', SEND));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    expect(apiPost.mock.calls[0][0]).toBe('/send');
    expect(apiPost.mock.calls[0][1]).toEqual({
      to: shownTo,
      subject: shownSubject,
      body: shownBody,
      threadId: THREAD_ID,
      // The Message-ID of the most recent message in the thread.
      inReplyTo: LAST_MESSAGE_ID,
      confirmed: true
    });
  });

  it('does not double-prefix the subject — the server owns the "Re: "', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await writeFollowUp(user);
    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');
    await user.click(screen.getByRole('button', SEND));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1].subject).toBe(SUBJECT);
    expect(apiPost.mock.calls[0][1].subject).not.toMatch(/^Re:/);
  });

  it('prefills the recipient from whoever spoke last in the thread', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await writeFollowUp(user);

    // The reply came from Sam, so the follow-up answers Sam.
    expect(screen.getByText(`Replying to ${RECIPIENT}`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');
    await user.click(screen.getByRole('button', SEND));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1].to).toBe(RECIPIENT);
  });

  it('shows the sent confirmation and refreshes that thread', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    expect(detailRequests()).toHaveLength(0);

    await writeFollowUp(user);
    expect(detailRequests()).toHaveLength(1);

    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');
    await user.click(screen.getByRole('button', SEND));

    expect(await screen.findByText('msg-9')).toBeInTheDocument();
    await waitFor(() => expect(detailRequests()).toHaveLength(2));
  });
});

describe('Follow-up — nothing reaches /send around the dialog', () => {
  it('posts nothing while browsing, opening and abandoning the composer', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText(SUBJECT);

    // The register itself.
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await user.type(screen.getByLabelText('Search subject or recipient'), 'launch');

    // The detail, the composer, and backing out of it again.
    await user.click(screen.getByText(SUBJECT));
    await user.click(await screen.findByRole('button', FOLLOW_UP));
    await user.type(screen.getByLabelText('Follow-up body'), FOLLOW_UP_BODY);
    await user.click(screen.getByRole('button', { name: /back to the thread/i }));
    await user.click(await screen.findByRole('button', FOLLOW_UP));

    // Not one POST anywhere in that walk — /send has exactly one caller.
    expect(postedPaths()).toEqual([]);
  });

  it('will not open the dialog on an empty body, so there is nothing to approve', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText(SUBJECT);
    await user.click(screen.getByText(SUBJECT));
    await user.click(await screen.findByRole('button', FOLLOW_UP));

    expect(screen.getByRole('button', REVIEW)).toBeDisabled();

    await user.click(screen.getByRole('button', REVIEW));

    expect(screen.queryByText('Send this letter?')).not.toBeInTheDocument();
    expect(postedPaths()).toEqual([]);
  });

  it('Cancel in the dialog returns to the composer and sends nothing', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await writeFollowUp(user);
    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');

    await user.click(screen.getByRole('button', CANCEL));

    expect(screen.queryByText('Send this letter?')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Follow-up body')).toHaveValue(FOLLOW_UP_BODY);
    expect(postedPaths()).toEqual([]);
  });

  it('disables the send button while the follow-up is in flight', async () => {
    let release;
    apiPost.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await writeFollowUp(user);
    await user.click(screen.getByRole('button', REVIEW));
    await screen.findByText('Send this letter?');
    await user.click(screen.getByRole('button', SEND));

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.queryByRole('button', SEND)).not.toBeInTheDocument();
    expect(postedPaths()).toEqual(['/send']);

    release({ messageId: 'msg-9', threadId: THREAD_ID });
    expect(await screen.findByText('msg-9')).toBeInTheDocument();
  });
});
