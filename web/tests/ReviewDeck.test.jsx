import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The review deck: one letter fills the view, Enter approves it and moves on.
 *
 * What is pinned here is the approval gate under a keyboard flow. Enter must
 * approve THE LETTER ON SCREEN — an off-by-one approves a different person's
 * letter, which is the worst bug this screen can have — the arrows must move
 * without sending anything, and Enter inside a field must type a newline rather
 * than approve, because that is the mistake that silently approves letters while
 * somebody is still writing them. Enter aimed at some other control on the page
 * is not the deck's to act on either — the deck renders inline, not as an overlay.
 *
 * The rest are the guarantees the single-letter reviewer used to hold before the
 * deck replaced it: an unsaved edit rides along with the approval, a refusal is
 * shown rather than assumed away, a letter that is not the user's reads as
 * absent, and a recipient with no draft cannot be approved at all.
 *
 * The api module is mocked with a small stand-in for the server, so an approval
 * sticks and an edit comes back as `edited_body`, the way the real one answers.
 */

const { apiGet, apiPatch, apiPost, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  navigateTo: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  apiFetch: vi.fn()
}));

vi.mock('../src/lib/navigate.js', () => ({ navigateTo, getQueryParam: () => null }));

const { default: ReviewDeck } = await import('../src/components/ReviewDeck.jsx');
const { default: CampaignDetail } = await import('../src/components/CampaignDetail.jsx');

const CAMPAIGN_ID = 'c-1';

const ROLL = [
  {
    id: 'l-1',
    email: 'marguerite@blackwood.example',
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    status: 'generated',
    fidelity_score: 92
  },
  {
    id: 'l-2',
    email: 'sam@corp.example',
    first_name: 'Sam',
    last_name: 'Rivera',
    company: 'Corp',
    status: 'generated',
    fidelity_score: 61
  },
  {
    id: 'l-3',
    email: 'ada@lovelace.example',
    first_name: 'Ada',
    last_name: 'Lovelace',
    company: 'Analytical',
    status: 'generated',
    fidelity_score: 88
  }
];

const SUBJECTS = {
  'l-1': 'a question about Blackwood',
  'l-2': 'a question about Corp',
  'l-3': 'a question about Analytical'
};

const BODIES = {
  'l-1': 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna',
  'l-2': 'hi Sam\n\nsaw the launch. worth 15 minutes?\n\nthanks,\nAna',
  'l-3': 'Ada —\n\nworth 15 minutes next week?\n\nthanks,\nAna'
};

/** What the server holds for each recipient, between requests. */
const stored = new Map();

function storedLetter(id, overrides = {}) {
  const lead = ROLL.find((entry) => entry.id === id);

  return {
    ...lead,
    campaign_id: CAMPAIGN_ID,
    generated_subject: SUBJECTS[id],
    generated_body: BODIES[id],
    edited_body: null,
    ...overrides
  };
}

function idFrom(path) {
  return path.replace('/leads/', '').replace('/regenerate', '');
}

function notFound() {
  const err = new Error('Recipient not found');
  err.status = 404;

  return err;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();

  stored.clear();
  ROLL.forEach((lead) => stored.set(lead.id, storedLetter(lead.id)));

  apiGet.mockImplementation((path) => {
    if (path.startsWith('/campaigns/')) {
      return Promise.resolve({
        campaign: {
          id: CAMPAIGN_ID,
          name: 'Series A founders',
          mode: 'voice',
          status: 'review',
          sentCount: 0,
          repliedCount: 0,
          leads: ROLL
        }
      });
    }

    const lead = stored.get(idFrom(path));

    return lead ? Promise.resolve({ lead: { ...lead } }) : Promise.reject(notFound());
  });

  // Mirrors the server: an edit lands in edited_body, approval flips the status.
  apiPatch.mockImplementation((path, patch) => {
    const id = idFrom(path);
    const next = { ...stored.get(id) };

    if (typeof patch?.subject === 'string') next.generated_subject = patch.subject;
    if (typeof patch?.body === 'string') next.edited_body = patch.body;
    if (patch?.approve === true) next.status = 'approved';

    stored.set(id, next);

    return Promise.resolve({ lead: { ...next } });
  });
});

function renderDeck(options = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onShown = options.onShown ?? vi.fn();

  render(
    <ReviewDeck
      leads={ROLL}
      startLeadId={options.startLeadId ?? 'l-1'}
      onClose={onClose}
      onChanged={vi.fn()}
      onShown={onShown}
    />
  );

  return { onClose, onShown };
}

/** Every /leads/:id PATCH the deck sent, in order. */
function approvedPaths() {
  return apiPatch.mock.calls.filter(([, patch]) => patch?.approve === true).map(([path]) => path);
}

describe('the review deck', () => {
  it('opens at the letter that was asked for, and fetches only that one', async () => {
    renderDeck({ startLeadId: 'l-2' });

    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();
    expect(screen.getByLabelText('Email body')).toHaveValue(BODIES['l-2']);
    expect(screen.getByText('Letter 2 of 3')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/leads/l-2');
  });

  it('names itself and keeps the shortcuts on screen', async () => {
    renderDeck();

    await screen.findByDisplayValue(SUBJECTS['l-1']);

    expect(screen.getByRole('region', { name: 'Review deck' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('approves the letter on screen — by id — and advances', async () => {
    const user = userEvent.setup();
    renderDeck({ startLeadId: 'l-2' });
    await screen.findByDisplayValue(SUBJECTS['l-2']);

    await user.keyboard('{Enter}');

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith('/leads/l-2', { approve: true });
    expect(await screen.findByDisplayValue(SUBJECTS['l-3'])).toBeInTheDocument();
    expect(screen.getByText('Letter 3 of 3')).toBeInTheDocument();
  });

  it('approves each letter as it is reached, never the one before it', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{Enter}');
    await screen.findByDisplayValue(SUBJECTS['l-2']);
    await user.keyboard('{Enter}');
    await screen.findByDisplayValue(SUBJECTS['l-3']);

    expect(approvedPaths()).toEqual(['/leads/l-1', '/leads/l-2']);
  });

  it('moves on the arrows without approving anything', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{ArrowRight}');
    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(await screen.findByDisplayValue(SUBJECTS['l-3'])).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();

    // Reading is not approving.
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('types a newline when Enter is pressed inside the body, and approves nothing', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('e');
    const body = screen.getByLabelText('Email body');
    expect(body).toBeEnabled();

    await user.type(body, '{enter}');

    expect(body).toHaveValue(`${BODIES['l-1']}\n`);
    expect(apiPatch).not.toHaveBeenCalled();
    // And the deck did not move on behind the typing.
    expect(screen.getByText('Letter 1 of 3')).toBeInTheDocument();
  });

  it('approves nothing when Enter is pressed inside the subject', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('e');
    await user.click(screen.getByLabelText('Subject'));
    await user.keyboard('{Enter}');

    expect(apiPatch).not.toHaveBeenCalled();
    expect(screen.getByText('Letter 1 of 3')).toBeInTheDocument();
  });

  it('approves nothing that has not been displayed', async () => {
    const user = userEvent.setup();
    const pending = new Promise(() => {});
    const answer = apiGet.getMockImplementation();
    apiGet.mockImplementation((path) => (path === '/leads/l-3' ? pending : answer(path)));

    renderDeck({ startLeadId: 'l-2' });
    await screen.findByDisplayValue(SUBJECTS['l-2']);

    await user.keyboard('{Enter}');
    // l-3 is now the open card, but its letter has never been rendered.
    expect(await screen.findByText(/Fetching the letter/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith('/leads/l-2', { approve: true });
  });

  it('shows an approved letter as approved when it is revisited', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{Enter}');
    await screen.findByDisplayValue(SUBJECTS['l-2']);
    await user.keyboard('{ArrowLeft}');

    expect(await screen.findByDisplayValue(SUBJECTS['l-1'])).toBeInTheDocument();
    expect(screen.getByText(/may be sent/i)).toBeInTheDocument();
  });

  it('lets an approved letter be approved again without erroring', async () => {
    const user = userEvent.setup();
    stored.set('l-1', storedLetter('l-1', { status: 'approved' }));
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{Enter}');

    expect(apiPatch).toHaveBeenCalledWith('/leads/l-1', { approve: true });
    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flags a letter under 80 as one to read closely', async () => {
    renderDeck({ startLeadId: 'l-2' });

    expect(await screen.findByText(/low fidelity — read closely/)).toBeInTheDocument();
    expect(screen.getByText(/scored under 80/i)).toBeInTheDocument();
  });

  it('does not flag a letter that scored at or above 80', async () => {
    renderDeck();

    expect(await screen.findByText('sounds like you')).toBeInTheDocument();
    expect(screen.queryByText(/low fidelity/)).not.toBeInTheDocument();
  });

  it('returns to the list on Esc', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the field before it leaves the deck', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('e');
    await user.type(screen.getByLabelText('Email body'), ' ok?');
    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stores an edit as edited_body, and shows the edit rather than the draft', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('e');
    await user.type(screen.getByLabelText('Email body'), ' ok?');
    await user.click(screen.getByRole('button', { name: 'Save edits' }));

    const edited = `${BODIES['l-1']} ok?`;

    expect(apiPatch).toHaveBeenCalledWith('/leads/l-1', {
      subject: SUBJECTS['l-1'],
      body: edited
    });
    expect(stored.get('l-1').edited_body).toBe(edited);
    // The draft underneath is untouched, and the edit is what the deck shows.
    expect(stored.get('l-1').generated_body).toBe(BODIES['l-1']);
    expect(await screen.findByLabelText('Email body')).toHaveValue(edited);
  });

  it('runs the approved count as letters are approved', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    expect(screen.getByText('0 approved')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(await screen.findByText('1 approved')).toBeInTheDocument();

    await screen.findByDisplayValue(SUBJECTS['l-2']);
    await user.keyboard('{Enter}');
    expect(await screen.findByText('2 approved')).toBeInTheDocument();
  });

  it('says when the last letter is done and offers the way back', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDeck({ startLeadId: 'l-3' });
    await screen.findByDisplayValue(SUBJECTS['l-3']);

    await user.keyboard('{Enter}');

    expect(await screen.findByText(/that was the last letter/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to the list' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays on the letter, and says why, when the server refuses the approval', async () => {
    const user = userEvent.setup();
    const refused = new Error('A sent recipient cannot be approved');
    refused.status = 400;
    apiPatch.mockRejectedValue(refused);

    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);
    expect(screen.getByText('0 approved')).toBeInTheDocument();

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A sent recipient cannot be approved'
    );
    // An approval the server did not store must not advance the deck: a reviewer
    // who is moved on believes a letter was approved that was not, and the count
    // would agree with them.
    expect(screen.getByText('Letter 1 of 3')).toBeInTheDocument();
    expect(screen.getByDisplayValue(SUBJECTS['l-1'])).toBeInTheDocument();
    expect(screen.getByText('0 approved')).toBeInTheDocument();
  });

  it('approves nothing for a letter whose words are not the ones on screen', async () => {
    const user = userEvent.setup();

    // Enter held down. The repeat lands in the render between the deck advancing
    // and the next letter arriving — the card on screen is still the letter
    // before it, so this keystroke would approve a letter nobody has read.
    function onShown(id) {
      if (id !== 'l-2') return;

      const deck = document.querySelector('section.deck');

      deck?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    }

    renderDeck({ onShown });
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('{Enter}');
    await screen.findByDisplayValue(SUBJECTS['l-2']);

    // l-1 was read and approved. l-2 was not — its words had not been drawn yet.
    expect(approvedPaths()).toEqual(['/leads/l-1']);
    expect(stored.get('l-2').status).toBe('generated');
  });

  it('approves nothing when the keystroke was aimed outside the deck', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    // The deck renders inline beside the rest of the campaign screen, so focus
    // can sit on a control that is not ours. Enter there belongs to that control.
    screen.getByRole('region', { name: 'Review deck' }).blur();
    await user.keyboard('{Enter}');

    expect(apiPatch).not.toHaveBeenCalled();
    expect(screen.getByText('Letter 1 of 3')).toBeInTheDocument();
  });

  it('approves the unsaved edit in the same request that approves the letter', async () => {
    const user = userEvent.setup();
    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    await user.keyboard('e');
    await user.type(screen.getByLabelText('Email body'), ' ok?');
    await user.click(screen.getByRole('button', { name: /approve & next/i }));

    const edited = `${BODIES['l-1']} ok?`;

    // The words on screen and the words approved are one request, never two.
    expect(apiPatch).toHaveBeenCalledWith('/leads/l-1', {
      subject: SUBJECTS['l-1'],
      body: edited,
      approve: true
    });
    expect(stored.get('l-1').edited_body).toBe(edited);
    expect(stored.get('l-1').status).toBe('approved');
    expect(stored.get('l-1').generated_body).toBe(BODIES['l-1']);
    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();
  });

  it('shows the edit rather than the draft when the letter has already been edited', async () => {
    const edited = 'hey Marguerite\n\nworth 15 minutes next week?\n\nthanks,\nAna';
    stored.set('l-1', storedLetter('l-1', { edited_body: edited }));

    renderDeck();

    // The field shows what would actually be sent.
    expect(await screen.findByLabelText('Email body')).toHaveValue(edited);
  });

  it('offers no approval for a recipient that has never been drafted for', async () => {
    stored.set(
      'l-1',
      storedLetter('l-1', { status: 'pending', generated_subject: null, generated_body: null })
    );

    renderDeck();

    // The letter has been fetched — there is simply nothing to approve.
    await screen.findByLabelText('Email body');

    expect(screen.getByRole('button', { name: /approve & next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('offers no approval for a letter that has already gone out', async () => {
    stored.set('l-1', storedLetter('l-1', { status: 'sent' }));

    renderDeck();
    await screen.findByDisplayValue(SUBJECTS['l-1']);

    // A sent letter is nobody's to approve or change any more.
    expect(screen.getByRole('button', { name: /approve & next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('redrafts just this letter, and approves nothing by doing it', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ lead: storedLetter('l-2', { fidelity_score: 88 }) });

    renderDeck({ startLeadId: 'l-2' });
    await screen.findByDisplayValue(SUBJECTS['l-2']);

    await user.click(screen.getByRole('button', { name: 'Redraft' }));

    expect(apiPost).toHaveBeenCalledWith('/leads/l-2/regenerate', {});
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('reads a letter that is not theirs as absent, not as a fault', async () => {
    stored.delete('l-1');

    renderDeck();

    expect(await screen.findByText(/isn't in your roll/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('opening the deck from the campaign list', () => {
  it('opens at the row that was clicked', async () => {
    const user = userEvent.setup();
    render(<CampaignDetail campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Sam Rivera');
    // The list carries no letters until one is opened.
    expect(screen.queryByLabelText('Email body')).not.toBeInTheDocument();

    await user.click(screen.getByText('Sam Rivera'));

    expect(await screen.findByDisplayValue(SUBJECTS['l-2'])).toBeInTheDocument();
    expect(screen.getByText('Letter 2 of 3')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/leads/l-2');
  });
});
