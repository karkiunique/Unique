import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: CorpusViewer } = await import('../src/components/CorpusViewer.jsx');

function apiError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** A row the cleaner clearly handled: quote stripped, bytes removed, short, plain text. */
function cleanEmail(overrides = {}) {
  return {
    index: 0,
    cleanedChars: 210,
    rawChars: 640,
    strippedChars: 430,
    removed: { quotedReply: true, signature: true, html: false },
    cleaned: 'hey sam, quick one about the pricing page. worth a look this week?',
    ...overrides
  };
}

function payload(emails, summary = {}) {
  return {
    summary: {
      messageCount: emails.length,
      totalCleanedChars: 4210,
      overCharBudget: false,
      cappedAt: 100,
      ...summary
    },
    emails
  };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('CorpusViewer — visibility', () => {
  it('renders nothing at all when the dev route 404s', async () => {
    apiGet.mockRejectedValue(apiError('Not found', 404));

    const { container } = render(<CorpusViewer />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/dev/ingest-preview'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('CorpusViewer — summary', () => {
  it('renders the summary numbers', async () => {
    apiGet.mockResolvedValue(payload([cleanEmail()]));

    render(<CorpusViewer />);

    expect(await screen.findByText('Ingestion preview')).toBeInTheDocument();
    expect(screen.getByText('4210')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  it('shows the suspect count', async () => {
    apiGet.mockResolvedValue(
      payload([
        cleanEmail({ index: 0 }),
        cleanEmail({ index: 1, removed: { quotedReply: false, signature: true, html: false } })
      ])
    );

    render(<CorpusViewer />);

    expect(await screen.findByText('1 of 2 emails look suspect')).toBeInTheDocument();
  });
});

describe('CorpusViewer — suspect detection', () => {
  it('does not flag a clean email', async () => {
    apiGet.mockResolvedValue(payload([cleanEmail()]));

    const { container } = render(<CorpusViewer />);

    expect(await screen.findByText('0 of 1 emails look suspect')).toBeInTheDocument();
    expect(container.querySelector('.row.suspect')).toBeNull();
  });

  it('flags an email where no quoted reply was stripped', async () => {
    apiGet.mockResolvedValue(
      payload([cleanEmail({ removed: { quotedReply: false, signature: true, html: false } })])
    );

    const { container } = render(<CorpusViewer />);

    expect(await screen.findByText(/No quoted reply stripped/i)).toBeInTheDocument();
    expect(container.querySelector('.row.suspect')).not.toBeNull();
  });

  it('flags a long email where nothing was stripped', async () => {
    apiGet.mockResolvedValue(
      payload([
        cleanEmail({
          cleanedChars: 900,
          rawChars: 900,
          strippedChars: 0,
          cleaned: 'a plain note with no quoting and no signature at all'
        })
      ])
    );

    render(<CorpusViewer />);

    expect(await screen.findByText('Nothing was removed from a long email')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 emails look suspect')).toBeInTheDocument();
  });

  it('flags an email long enough to be a whole thread', async () => {
    apiGet.mockResolvedValue(payload([cleanEmail({ cleanedChars: 5200, rawChars: 6000, strippedChars: 800 })]));

    render(<CorpusViewer />);

    expect(
      await screen.findByText('Very long — looks like a whole thread, not one message')
    ).toBeInTheDocument();
  });

  it('flags undecoded quoted-printable markers', async () => {
    apiGet.mockResolvedValue(
      payload([cleanEmail({ cleaned: 'thanks=20for=20the=20intro, will follow up' })])
    );

    render(<CorpusViewer />);

    expect(await screen.findByText('Undecoded quoted-printable (=20, =E2=, =C2=)')).toBeInTheDocument();
  });

  it('flags HTML residue in the cleaned text', async () => {
    apiGet.mockResolvedValue(payload([cleanEmail({ cleaned: '<div>hi sam</div>&nbsp;worth a look?' })]));

    render(<CorpusViewer />);

    expect(await screen.findByText('HTML residue in the cleaned text')).toBeInTheDocument();
  });
});

describe('CorpusViewer — raw text', () => {
  it('refetches with includeRaw=1 when the checkbox is ticked', async () => {
    apiGet.mockResolvedValue(payload([cleanEmail({ raw: 'hey sam,\n\n> quoted junk\n--\nSam' })]));
    const user = userEvent.setup();

    render(<CorpusViewer />);

    await screen.findByText('Ingestion preview');
    expect(apiGet).toHaveBeenCalledWith('/dev/ingest-preview');

    await user.click(screen.getByRole('checkbox', { name: /include raw/i }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/dev/ingest-preview?includeRaw=1'));
  });

  it('shows the body only after expanding the row', async () => {
    const cleaned = 'hey sam, quick one about the pricing page.';
    apiGet.mockResolvedValue(payload([cleanEmail({ cleaned })]));
    const user = userEvent.setup();

    render(<CorpusViewer />);

    await screen.findByText('Ingestion preview');
    expect(screen.queryByText(cleaned)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show body' }));

    expect(screen.getByText(cleaned)).toBeInTheDocument();
  });
});
