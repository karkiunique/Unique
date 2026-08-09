import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: CampaignLeadsPage } = await import('../src/pages/CampaignLeadsPage.jsx');

const FILE_LABEL = 'Recipient list (CSV)';
const EMAIL_SELECT = 'Email (required)';
const CAMPAIGN_ID = 'c-1';

function csvFile(text, name = 'leads.csv') {
  return new File([text], name, { type: 'text/csv' });
}

/** Choose a file and wait for the parse to land. */
async function pick(user, text) {
  await user.upload(screen.getByLabelText(FILE_LABEL), csvFile(text));
  await screen.findByText(/rows found/);
}

function addButton() {
  return screen.getByRole('button', { name: /^add \d+ recipients?$/i });
}

function longCsv(rowCount) {
  const rows = Array.from(
    { length: rowCount },
    (_unused, index) => `person${index}@corp.com,Person${index}`
  );

  return `Email,First Name\n${rows.join('\n')}\n`;
}

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue({ inserted: 1, skipped: [], rejected: [], flagged: [] });
});

describe('CampaignLeadsPage — column mapping', () => {
  it('needs no manual mapping for a well-formed file', async () => {
    const user = userEvent.setup();

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email,First Name,Company\nsam@corp.com,Sam,Corp\n');

    expect(screen.getByLabelText(EMAIL_SELECT)).toHaveValue('Email');
    expect(screen.getByLabelText('First name')).toHaveValue('First Name');
    expect(screen.getByLabelText('Company')).toHaveValue('Company');

    expect(addButton()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('re-maps a column by hand and redraws the preview', async () => {
    const user = userEvent.setup();

    const { container } = render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Contact,Company\nsam@corp.com,Corp\n');

    // Nothing here is called anything like an address, so nothing was guessed.
    expect(screen.getByLabelText(EMAIL_SELECT)).toHaveValue('');
    const preview = container.querySelector('.lead-preview');
    expect(within(preview).queryByText('sam@corp.com')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(EMAIL_SELECT), 'Contact');

    expect(screen.getByLabelText(EMAIL_SELECT)).toHaveValue('Contact');
    expect(within(preview).getByText('sam@corp.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add 1 recipient$/i })).toBeEnabled();
  });

  it('shows the preview as the rows will actually be stored, trimmed', async () => {
    const user = userEvent.setup();

    const { container } = render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email,First Name,Salary\n  sam@corp.com  ,  Sam  ,120000\n');

    const preview = container.querySelector('.lead-preview');

    expect(within(preview).getByText('sam@corp.com')).toBeInTheDocument();
    expect(within(preview).getByText('Sam')).toBeInTheDocument();
    // An unmapped column is not previewed because it is not being uploaded.
    expect(within(preview).queryByText('120000')).not.toBeInTheDocument();
  });
});

describe('CampaignLeadsPage — the email column is the one requirement', () => {
  it('blocks the upload until an email column is mapped', async () => {
    const user = userEvent.setup();

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Name,Company,Notes\nSam,Corp,called twice\n');

    expect(screen.getByRole('alert')).toHaveTextContent(/no email column is mapped/i);
    expect(addButton()).toBeDisabled();

    await user.click(addButton());

    expect(apiPost).not.toHaveBeenCalled();
  });

  it('counts the rows that have no address instead of hiding them', async () => {
    const user = userEvent.setup();

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email,First Name\nsam@corp.com,Sam\n,Lee\n   ,Nur\n');

    expect(screen.getByText(/3 rows found · 1 with an email · 2 without/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add 1 recipient$/i })).toBeEnabled();
  });

  it('names an empty file as empty rather than as a missing column', async () => {
    const user = userEvent.setup();

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, '');

    expect(screen.getByText('This file is empty — there is nothing to read.')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('CampaignLeadsPage — uploading', () => {
  it('sends a long file in batches and adds the results up', async () => {
    const user = userEvent.setup();
    apiPost.mockImplementation(async (_path, body) => ({
      inserted: body.rows.length,
      skipped: [],
      rejected: [],
      flagged: []
    }));

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, longCsv(450));

    await user.click(screen.getByRole('button', { name: /add 450 recipients/i }));

    // The 1MB JSON limit on the server is a deliberate control, so the client
    // splits the file rather than the limit being raised.
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(3));
    expect(apiPost.mock.calls.map(([, body]) => body.rows.length)).toEqual([200, 200, 50]);
    expect(apiPost.mock.calls[0][0]).toBe(`/campaigns/${CAMPAIGN_ID}/leads`);

    expect(await screen.findByText('450 added')).toBeInTheDocument();
  });

  it('re-bases the row numbers each batch reports, so they point at the file', async () => {
    const user = userEvent.setup();
    apiPost.mockImplementation(async (_path, body) => ({
      inserted: body.rows.length - 1,
      // Every batch reports its own row 0; the page has to offset them.
      skipped: [{ index: 0, email: body.rows[0].email, reason: 'duplicate_in_campaign' }],
      rejected: [],
      // ...and its own row 1, which is the one the summary prints a number for.
      flagged: [{ index: 1, email: body.rows[1].email, status: 'invalid', reasons: ['no_mx'] }]
    }));

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, longCsv(250));

    await user.click(screen.getByRole('button', { name: /add 250 recipients/i }));

    expect(await screen.findByText('248 added')).toBeInTheDocument();
    expect(screen.getByText('2 skipped')).toBeInTheDocument();
    expect(screen.getByText('2 — already on this campaign')).toBeInTheDocument();

    // The whole point of the offset, and the only assertion here that reads an
    // index: both batches reported index 1 for themselves, but the second
    // batch's row 1 is row 202 of the file. Un-offset it would read 'Row 2'
    // twice and send the user to the wrong line.
    const firstFlag = screen.getByText(
      'person1@corp.com — this domain has no mail server, so it will bounce'
    );
    const secondFlag = screen.getByText(
      'person201@corp.com — this domain has no mail server, so it will bounce'
    );

    expect(within(firstFlag).getByText('Row 2')).toBeInTheDocument();
    expect(within(secondFlag).getByText('Row 202')).toBeInTheDocument();
  });

  it('shows what was added, what was skipped and what was rejected', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      inserted: 2,
      skipped: [{ index: 2, email: 'sam@corp.com', reason: 'duplicate_in_campaign' }],
      rejected: [{ index: 3, email: 'nope', reason: 'invalid_email' }],
      flagged: []
    });

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email\nsam@corp.com\nlee@corp.com\nsam@corp.com\nnope\n');

    await user.click(screen.getByRole('button', { name: /add 4 recipients/i }));

    expect(await screen.findByText('2 added')).toBeInTheDocument();
    expect(screen.getByText('1 skipped')).toBeInTheDocument();
    expect(screen.getByText('1 rejected')).toBeInTheDocument();
    expect(screen.getByText('1 — already on this campaign')).toBeInTheDocument();
    expect(screen.getByText('1 — not a valid email address')).toBeInTheDocument();
  });

  it('tells the user when the server refused the upload', async () => {
    const user = userEvent.setup();
    const err = new Error('There are no recipients to add');
    err.status = 400;
    apiPost.mockRejectedValue(err);

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email\nsam@corp.com\n');

    await user.click(screen.getByRole('button', { name: /add 1 recipient$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('There are no recipients to add');
  });

  it('tells the campaign to reload once the recipients are in', async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} onAdded={onAdded} />);
    await pick(user, 'Email\nsam@corp.com\n');

    await user.click(screen.getByRole('button', { name: /add 1 recipient$/i }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });
});

describe('CampaignLeadsPage — bounce risk is advisory', () => {
  it('flags a dead domain without blocking anything, and adds it anyway', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      inserted: 2,
      skipped: [],
      rejected: [],
      flagged: [{ index: 1, email: 'lee@nowhere.example', status: 'invalid', reasons: ['no_mx'] }]
    });

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email\nsam@corp.com\nlee@nowhere.example\n');

    await user.click(screen.getByRole('button', { name: /add 2 recipients/i }));

    // Both went in. The flag is a warning about the user's own sender
    // reputation, never a gate on their upload.
    expect(await screen.findByText('2 added')).toBeInTheDocument();
    expect(
      screen.getByText('lee@nowhere.example — this domain has no mail server, so it will bounce')
    ).toBeInTheDocument();
    expect(screen.getByText(/advisory only/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("reads a lookup that did not finish as unchecked, not as a bad address", async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      inserted: 1,
      skipped: [],
      rejected: [],
      flagged: [{ index: 0, email: 'sam@slow.example', status: 'unknown', reasons: ['dns_timeout'] }]
    });

    render(<CampaignLeadsPage campaignId={CAMPAIGN_ID} />);
    await pick(user, 'Email\nsam@slow.example\n');

    await user.click(screen.getByRole('button', { name: /add 1 recipient$/i }));

    expect(await screen.findByText('1 added')).toBeInTheDocument();
    expect(
      screen.getByText('sam@slow.example — the domain lookup timed out, so this one is unchecked')
    ).toBeInTheDocument();
  });
});
