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

const { default: CampaignBuilderPage } = await import('../src/pages/CampaignBuilderPage.jsx');

const NAME_LABEL = 'Campaign name';
const SUBJECT_LABEL = 'Subject line';
const TEMPLATE_LABEL = 'Letter template';
const PERSONALIZED = '{{personalized}}';
const CREATE = { name: /create campaign/i };

/** The merge-var chips type the braces, so no test ever has to escape them. */
function chip(token) {
  return screen.getByRole('button', { name: token });
}

async function fillName(user, value = 'Series A founders') {
  await user.type(screen.getByLabelText(NAME_LABEL), value);
}

async function chooseTemplateMode(user) {
  await user.click(screen.getByRole('button', { name: 'Template' }));
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();
  apiPost.mockResolvedValue({ campaign: { id: 'c-9' } });
});

describe('CampaignBuilderPage — mode', () => {
  it('starts in voice mode and switches to template and back', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);

    const voice = screen.getByRole('button', { name: 'Voice' });
    const template = screen.getByRole('button', { name: 'Template' });

    expect(voice).toHaveAttribute('aria-pressed', 'true');
    expect(template).toHaveAttribute('aria-pressed', 'false');

    await user.click(template);
    expect(template).toHaveAttribute('aria-pressed', 'true');
    expect(voice).toHaveAttribute('aria-pressed', 'false');

    await user.click(voice);
    expect(voice).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the template editor and merge bar only in template mode', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);

    expect(screen.queryByLabelText(TEMPLATE_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PERSONALIZED })).not.toBeInTheDocument();

    await chooseTemplateMode(user);

    expect(screen.getByLabelText(TEMPLATE_LABEL)).toBeInTheDocument();
    expect(chip('{{first_name}}')).toBeInTheDocument();
    expect(chip('{{company}}')).toBeInTheDocument();
    expect(chip('{{title}}')).toBeInTheDocument();
    expect(chip(PERSONALIZED)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Voice' }));

    expect(screen.queryByLabelText(TEMPLATE_LABEL)).not.toBeInTheDocument();
  });
});

describe('CampaignBuilderPage — the merge bar', () => {
  it('inserts a merge var at the cursor', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await chooseTemplateMode(user);

    const field = screen.getByLabelText(TEMPLATE_LABEL);
    await user.type(field, 'Hi ');
    await user.click(chip('{{first_name}}'));

    expect(field).toHaveValue('Hi {{first_name}}');

    await user.type(field, ' — ');
    await user.click(chip(PERSONALIZED));

    expect(field).toHaveValue(`Hi {{first_name}} — ${PERSONALIZED}`);
  });

  it('inserts in the middle of the template, not at the end', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await chooseTemplateMode(user);

    const field = screen.getByLabelText(TEMPLATE_LABEL);
    await user.type(field, 'Hi there');
    // Caret after "Hi ", the way a click into the text would leave it.
    field.setSelectionRange(3, 3);

    await user.click(chip('{{company}}'));

    expect(field).toHaveValue('Hi {{company}}there');
  });
});

describe('CampaignBuilderPage — submitting', () => {
  it('blocks submission in template mode until {{personalized}} is present', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);
    await chooseTemplateMode(user);

    const field = screen.getByLabelText(TEMPLATE_LABEL);
    await user.type(field, 'Hi there, we do cold email. worth 15 minutes?');

    // A template with no personalised section is a mail merge — the same letter
    // to everyone. The server rejects it too; this is only the earlier no.
    expect(screen.getByRole('button', CREATE)).toBeDisabled();
    expect(screen.getByText(/needs at least one/i)).toBeInTheDocument();

    await user.click(chip(PERSONALIZED));

    expect(screen.getByRole('button', CREATE)).toBeEnabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('blocks submission without a name', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);

    expect(screen.getByRole('button', CREATE)).toBeDisabled();

    await user.type(screen.getByLabelText(NAME_LABEL), '   ');
    expect(screen.getByRole('button', CREATE)).toBeDisabled();

    await user.type(screen.getByLabelText(NAME_LABEL), 'Series A founders');
    expect(screen.getByRole('button', CREATE)).toBeEnabled();
  });

  it('posts a voice campaign with no template body at all', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);
    await user.type(screen.getByLabelText(SUBJECT_LABEL), 'a question about the launch');

    await user.click(screen.getByRole('button', CREATE));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/campaigns', {
      name: 'Series A founders',
      mode: 'voice',
      subject_template: 'a question about the launch'
    });
    expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9');
  });

  it('posts a template campaign with the template body', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);
    await chooseTemplateMode(user);

    const field = screen.getByLabelText(TEMPLATE_LABEL);
    await user.type(field, 'Hi ');
    await user.click(chip('{{first_name}}'));
    await user.type(field, ', ');
    await user.click(chip(PERSONALIZED));

    await user.click(screen.getByRole('button', CREATE));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/campaigns', {
      name: 'Series A founders',
      mode: 'template',
      subject_template: '',
      template_body: `Hi {{first_name}}, ${PERSONALIZED}`
    });
  });

  it('renders the server message when the create fails, and stays put', async () => {
    const err = new Error("Mode must be either 'voice' or 'template'");
    err.status = 400;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);

    await user.click(screen.getByRole('button', CREATE));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Mode must be either 'voice' or 'template'"
    );
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('goes back to the roll without creating anything', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);

    await user.click(screen.getByRole('button', { name: /back to the roll/i }));

    expect(navigateTo).toHaveBeenCalledWith('/campaigns');
    expect(apiPost).not.toHaveBeenCalled();
  });
});
