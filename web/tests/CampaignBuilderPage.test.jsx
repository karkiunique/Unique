import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet, apiPost, apiPatch, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  navigateTo: vi.fn()
}));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  apiFetch: vi.fn()
}));

// Stubbed so nothing in the tree can actually navigate.
vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  getQueryParam: () => null
}));

const { default: CampaignBuilderPage } = await import('../src/pages/CampaignBuilderPage.jsx');

const NAME_LABEL = 'Campaign name';
const BRIEF_LABEL = 'What is this email about? Tell me as much as you can.';
const SUBJECT_LABEL = 'Subject line';
const TEMPLATE_LABEL = 'Letter template';
const ANSWER_LABEL = 'Your answer';
const PERSONALIZED = '{{personalized}}';
const CREATE = { name: /create campaign/i };

const BRIEF = 'We run payroll for Nordic shipping firms and just closed our first two fleets.';
const QUESTIONS = [
  'Who at a shipping firm should reply?',
  'What is the one thing you want them to do?',
  'What results can you point to?'
];

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

/** Create answers with the campaign, the clarify pass with its questions. */
function answerClarifyWith(questions) {
  apiPost.mockImplementation((path) =>
    path.endsWith('/clarify')
      ? Promise.resolve({ campaignId: 'c-9', questions })
      : Promise.resolve({ campaign: { id: 'c-9' } })
  );
}

/** Fill the name and the brief, then create — the way into the clarify pass. */
async function createWithBrief(user) {
  await fillName(user);
  await user.type(screen.getByLabelText(BRIEF_LABEL), BRIEF);
  await user.click(screen.getByRole('button', CREATE));
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  navigateTo.mockReset();
  apiPost.mockResolvedValue({ campaign: { id: 'c-9' } });
  apiPatch.mockResolvedValue({ campaign: { id: 'c-9' } });
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

describe('CampaignBuilderPage — the brief', () => {
  /**
   * The brief is the generation goal (migration 004). A builder that collects it
   * and does not send it is the bug this loop exists to fix.
   */
  it('submits the brief with the campaign', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);
    await user.type(screen.getByLabelText(BRIEF_LABEL), BRIEF);

    await user.click(screen.getByRole('button', CREATE));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/campaigns', {
      name: 'Series A founders',
      mode: 'voice',
      subject_template: '',
      brief: BRIEF
    });
  });

  it('sends no brief key when the field is left empty', async () => {
    const user = userEvent.setup();

    render(<CampaignBuilderPage />);
    await fillName(user);
    await user.type(screen.getByLabelText(BRIEF_LABEL), '   ');

    await user.click(screen.getByRole('button', CREATE));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).not.toHaveProperty('brief');
  });

  it('asks for no clarifying questions when there is no brief', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await fillName(user);
    await user.click(screen.getByRole('button', CREATE));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9'));
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

describe('CampaignBuilderPage — the clarify pass', () => {
  it('asks the questions one at a time, never as a wall of boxes', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);

    expect(await screen.findByText(QUESTIONS[0])).toBeInTheDocument();
    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();

    // The other two are not on the screen at all, and there is one box.
    expect(screen.queryByText(QUESTIONS[1])).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTIONS[2])).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);

    expect(apiPost).toHaveBeenCalledWith('/campaigns/c-9/clarify');
    // Nothing is saved until the last question is answered or skipped.
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('advances to the next question when one is answered', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);
    await screen.findByText(QUESTIONS[0]);

    await user.type(screen.getByLabelText(ANSWER_LABEL), 'the head of finance');
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByText(QUESTIONS[1])).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    // The box is cleared for the new question, not left holding the last answer.
    expect(screen.getByLabelText(ANSWER_LABEL)).toHaveValue('');
    expect(apiPatch).not.toHaveBeenCalled();
  });

  /** A skip is a first-class outcome (CLAUDE.md, 2026-08-09), never a dead end. */
  it('skips a question without recording an answer for it', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);
    await screen.findByText(QUESTIONS[0]);

    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(screen.getByText(QUESTIONS[1])).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByText('Question 3 of 3')).toBeInTheDocument();

    // Skip is the only way past a question nobody wants to answer: the forward
    // button has nothing to record and stays shut.
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith('/campaigns/c-9', {
      clarifications: [
        { question: QUESTIONS[0], answer: null },
        { question: QUESTIONS[1], answer: null },
        { question: QUESTIONS[2], answer: null }
      ]
    });
  });

  it('saves the answers it has and goes on to the campaign', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);
    await screen.findByText(QUESTIONS[0]);

    await user.type(screen.getByLabelText(ANSWER_LABEL), 'the head of finance');
    await user.click(screen.getByRole('button', { name: /next/i }));

    await user.click(screen.getByRole('button', { name: 'Skip' }));

    await user.type(screen.getByLabelText(ANSWER_LABEL), 'we cut their close from nine days to two');
    await user.click(screen.getByRole('button', { name: /done/i }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith('/campaigns/c-9', {
      clarifications: [
        { question: QUESTIONS[0], answer: 'the head of finance' },
        { question: QUESTIONS[1], answer: null },
        { question: QUESTIONS[2], answer: 'we cut their close from nine days to two' }
      ]
    });
    expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9');
  });

  it('cannot go forward on an empty answer — that is what Skip is for', async () => {
    const user = userEvent.setup();
    answerClarifyWith(QUESTIONS);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);
    await screen.findByText(QUESTIONS[0]);

    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();

    await user.type(screen.getByLabelText(ANSWER_LABEL), '   ');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  /** Drafting is never blocked on a question — including one we failed to ask. */
  it('goes straight to the campaign when the clarify pass fails', async () => {
    const user = userEvent.setup();
    apiPost.mockImplementation((path) =>
      path.endsWith('/clarify')
        ? Promise.reject(new Error('The model did not return usable questions'))
        : Promise.resolve({ campaign: { id: 'c-9' } })
    );

    render(<CampaignBuilderPage />);
    await createWithBrief(user);

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9'));
    expect(screen.queryByLabelText(ANSWER_LABEL)).not.toBeInTheDocument();
  });

  it('goes straight to the campaign when the brief needs no questions', async () => {
    const user = userEvent.setup();
    answerClarifyWith([]);

    render(<CampaignBuilderPage />);
    await createWithBrief(user);

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9'));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('keeps the answers on screen when saving them fails', async () => {
    const user = userEvent.setup();
    answerClarifyWith([QUESTIONS[0]]);
    apiPatch.mockRejectedValue(new Error('Could not update the campaign'));

    render(<CampaignBuilderPage />);
    await createWithBrief(user);
    await screen.findByText(QUESTIONS[0]);

    await user.type(screen.getByLabelText(ANSWER_LABEL), 'the head of finance');
    await user.click(screen.getByRole('button', { name: /done/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the campaign');
    expect(navigateTo).not.toHaveBeenCalled();

    // A failed save must not strand anyone: both ways out are offered.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(apiPatch).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: /go to the campaign anyway/i }));
    expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-9');
  });
});
