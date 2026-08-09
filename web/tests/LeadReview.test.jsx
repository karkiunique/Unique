import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The money screen: one letter, read and approved on its own.
 *
 * The assertions that matter here are the ones about what leaves the browser.
 * Approving sends an approval for THIS lead and nothing else; approving after an
 * edit sends the edited words in the same request, so the letter on screen and
 * the letter approved can never be two different letters; and a draft the model
 * scored under 80 says so in words a reviewer cannot miss.
 */

const { apiGet, apiPatch, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn()
}));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  apiFetch: vi.fn()
}));

const { default: LeadReview } = await import('../src/components/LeadReview.jsx');

const LEAD_ID = 'l-1';
const SUBJECT = 'a question about Blackwood';
const DRAFT = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';
const EDIT = 'hey Marguerite\n\nworth 15 minutes next week?\n\nthanks,\nAna';

function lead(overrides = {}) {
  return {
    id: LEAD_ID,
    campaign_id: 'c-1',
    email: 'marguerite@blackwood.example',
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    status: 'generated',
    fidelity_score: 92,
    generated_subject: SUBJECT,
    generated_body: DRAFT,
    edited_body: null,
    ...overrides
  };
}

function renderReview(overrides = {}) {
  apiGet.mockResolvedValue({ lead: lead(overrides) });

  return render(<LeadReview leadId={LEAD_ID} onClose={vi.fn()} onChanged={vi.fn()} />);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPost.mockReset();
  apiPatch.mockResolvedValue({ lead: lead({ status: 'approved' }) });
  apiPost.mockResolvedValue({ lead: lead({ fidelity_score: 88 }) });
});

describe('LeadReview', () => {
  it('fetches this one letter and shows it', async () => {
    renderReview();

    expect(await screen.findByDisplayValue(SUBJECT)).toBeInTheDocument();
    expect(screen.getByLabelText('Email body')).toHaveValue(DRAFT);
    expect(apiGet).toHaveBeenCalledWith(`/leads/${LEAD_ID}`);
  });

  it('shows the edit rather than the draft when the user has already edited', async () => {
    renderReview({ edited_body: EDIT });

    // The field shows what would actually be sent.
    expect(await screen.findByLabelText('Email body')).toHaveValue(EDIT);
  });

  it('flags a draft under 80 as one to read closely', async () => {
    renderReview({ fidelity_score: 61 });

    expect(await screen.findByText(/low fidelity — read closely/)).toBeInTheDocument();
    expect(screen.getByText(/scored under 80/i)).toBeInTheDocument();
  });

  it('does not flag a draft that scored at or above 80', async () => {
    renderReview({ fidelity_score: 80 });

    expect(await screen.findByText('sounds like you')).toBeInTheDocument();
    expect(screen.queryByText(/low fidelity/)).not.toBeInTheDocument();
  });

  it('approves this lead, by id, and nothing else', async () => {
    const user = userEvent.setup();
    renderReview();
    await screen.findByDisplayValue(SUBJECT);

    await user.click(screen.getByRole('button', { name: /approve this letter/i }));

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith(`/leads/${LEAD_ID}`, { approve: true });
  });

  it('approves the edited words in the same request that approves them', async () => {
    const user = userEvent.setup();
    renderReview();
    await screen.findByDisplayValue(SUBJECT);

    await user.type(screen.getByLabelText('Email body'), ' ok?');
    await user.click(screen.getByRole('button', { name: /approve this letter/i }));

    expect(apiPatch).toHaveBeenCalledWith(`/leads/${LEAD_ID}`, {
      subject: SUBJECT,
      body: `${DRAFT} ok?`,
      approve: true
    });
  });

  it('saves an edit without approving anything', async () => {
    const user = userEvent.setup();
    renderReview();
    await screen.findByDisplayValue(SUBJECT);

    await user.type(screen.getByLabelText('Email body'), ' ok?');
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    expect(apiPatch).toHaveBeenCalledWith(`/leads/${LEAD_ID}`, {
      subject: SUBJECT,
      body: `${DRAFT} ok?`
    });
  });

  it('offers no approval for a recipient that has never been drafted for', async () => {
    renderReview({ status: 'pending', generated_subject: null, generated_body: null });

    await screen.findByRole('button', { name: /approve this letter/i });

    expect(screen.getByRole('button', { name: /approve this letter/i })).toBeDisabled();
    expect(screen.getByLabelText('Email body')).toBeDisabled();
  });

  it('offers no approval for a letter that has already gone out', async () => {
    renderReview({ status: 'sent' });

    await screen.findByDisplayValue(SUBJECT);

    expect(screen.getByRole('button', { name: /approve this letter/i })).toBeDisabled();
    expect(screen.getByLabelText('Subject')).toBeDisabled();
  });

  it('says so once the letter is approved', async () => {
    const user = userEvent.setup();
    renderReview();
    await screen.findByDisplayValue(SUBJECT);

    await user.click(screen.getByRole('button', { name: /approve this letter/i }));

    expect(await screen.findByText(/may be sent/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approved/i })).toBeDisabled();
  });

  it('redrafts just this lead', async () => {
    const user = userEvent.setup();
    renderReview({ fidelity_score: 61 });
    await screen.findByDisplayValue(SUBJECT);

    await user.click(screen.getByRole('button', { name: /redraft/i }));

    expect(apiPost).toHaveBeenCalledWith(`/leads/${LEAD_ID}/regenerate`, {});
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("shows the server's refusal rather than pretending the approval worked", async () => {
    const user = userEvent.setup();
    const err = new Error('A sent recipient cannot be approved');
    err.status = 400;
    apiPatch.mockRejectedValue(err);

    renderReview();
    await screen.findByDisplayValue(SUBJECT);

    await user.click(screen.getByRole('button', { name: /approve this letter/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A sent recipient cannot be approved');
  });

  it("reads a lead that is not theirs as absent, not as a fault", async () => {
    const err = new Error('Recipient not found');
    err.status = 404;
    apiGet.mockRejectedValue(err);

    render(<LeadReview leadId={LEAD_ID} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/isn't in your roll/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
