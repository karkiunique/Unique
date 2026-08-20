import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The standing target (CLAUDE.md, Decisions 2026-08-16).
 *
 * The property that matters most is not the form working — it is that the daily
 * number is presented as a CEILING. A user who reads it as a quota will treat a
 * short day as a bug and ask for the bar to be lowered, which is the one change
 * the whole design exists to prevent.
 */

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn(), put: apiPut },
  apiFetch: vi.fn()
}));

vi.mock('../src/lib/navigate.js', () => ({ navigateTo: vi.fn(), getQueryParam: () => null }));

const { default: TargetPage } = await import('../src/pages/TargetPage.jsx');

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue({ target: null });
  apiPut.mockReset().mockResolvedValue({ target: { id: 't1' } });
});

describe('the ceiling', () => {
  it('is described as a ceiling, not a quota', async () => {
    render(<TargetPage />);

    expect(await screen.findByLabelText(/Letters a day, at most/)).toBeInTheDocument();
    expect(screen.getByText(/A ceiling, not a quota/i)).toBeInTheDocument();
    expect(
      screen.getByText(/rather send you one letter worth reading than fill the number/i)
    ).toBeInTheDocument();
  });

  it('cannot be set beyond the range the server accepts', async () => {
    render(<TargetPage />);

    const field = await screen.findByLabelText(/Letters a day, at most/);
    expect(field).toHaveAttribute('max', '5');
    expect(field).toHaveAttribute('min', '1');
  });
});

describe('loading an existing target', () => {
  it('renders list criteria as comma-separated text', async () => {
    apiGet.mockResolvedValue({
      target: {
        titles: ['Director of Technology', 'Head of IT'],
        industries: ['K-12 education'],
        fit_notes: 'We sell classroom software.',
        daily_target: 3
      }
    });

    render(<TargetPage />);

    expect(await screen.findByLabelText('Job titles')).toHaveValue(
      'Director of Technology, Head of IT'
    );
    expect(screen.getByLabelText('Industries')).toHaveValue('K-12 education');
    expect(screen.getByLabelText(/good fit/)).toHaveValue('We sell classroom software.');
    expect(screen.getByLabelText(/Letters a day/)).toHaveValue(3);
  });

  it('starts empty for a user who has never set one', async () => {
    render(<TargetPage />);

    expect(await screen.findByLabelText('Job titles')).toHaveValue('');
    expect(screen.getByLabelText(/Letters a day/)).toHaveValue(2);
  });
});

describe('saving', () => {
  it('splits comma-separated text back into arrays', async () => {
    render(<TargetPage />);

    await userEvent.type(
      await screen.findByLabelText('Job titles'),
      'Director of Technology, Head of IT'
    );
    await userEvent.click(screen.getByRole('button', { name: /Save target/ }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [path, body] = apiPut.mock.calls[0];
    expect(path).toBe('/target');
    expect(body.titles).toEqual(['Director of Technology', 'Head of IT']);
  });

  /**
   * An untouched criterion must go up as [], which the server stores as null and
   * the gates read as "no constraint". It must never become [''] — a criterion
   * nothing can match would silently starve the queue.
   */
  it('sends an untouched criterion as an empty list, never as a list of one blank', async () => {
    render(<TargetPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Save target/ }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [, body] = apiPut.mock.calls[0];
    expect(body.industries).toEqual([]);
    expect(body.geos).toEqual([]);
    expect(body.excludeDomains).toEqual([]);
  });

  it('drops blank entries left by trailing commas', async () => {
    render(<TargetPage />);

    await userEvent.type(await screen.findByLabelText('Industries'), 'edtech, , k-12, ');
    await userEvent.click(screen.getByRole('button', { name: /Save target/ }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPut.mock.calls[0][1].industries).toEqual(['edtech', 'k-12']);
  });

  it('confirms the save and says when it takes effect', async () => {
    render(<TargetPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Save target/ }));

    expect(await screen.findByText(/Tonight/)).toBeInTheDocument();
  });

  it('reports a refusal instead of claiming it saved', async () => {
    apiPut.mockRejectedValue(new Error('Could not save your target'));

    render(<TargetPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Save target/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.queryByText(/Tonight/)).not.toBeInTheDocument();
  });
});
