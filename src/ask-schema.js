// Enhanced AskUserQuestion tool definition
// Replaces the Claude Code CLI's built-in schema with richer form capabilities

const enhancedAskTool = {
  name: 'AskUserQuestion',
  description: `Ask the user one or more questions via an interactive form. Use this whenever you need user input, confirmation, file selection, or a decision before proceeding. When in doubt, ask rather than assume — the user prefers to be consulted.

Question types:
- "select": Single-select from a list of options (renders as button group). Use for 2-6 choices.
- "multiselect": Multi-select from options (checkboxes). User can pick multiple.
- "text": Single-line text input.
- "textarea": Multi-line text input.
- "number": Numeric input with optional min/max/step.
- "toggle": Boolean yes/no switch.
- "dropdown": Single-select from a longer list (renders as dropdown menu). Use for 6+ choices.
- "file": File upload drop zone. Returns file path(s) relative to working directory. Use Read tool to access content.
- "confirm": Simple yes/no confirmation with a description.

Guidelines:
- Keep forms concise. Prefer fewer questions with clear defaults.
- For simple yes/no decisions, use "confirm" type.
- For choices under 6 items use "select"; for 6+ items use "dropdown".
- Set defaultValue when there's a sensible default to reduce user effort.
- Use showIf to hide follow-up questions until relevant (only reference earlier questions by id).
- Users can always type a custom answer for select/multiselect/dropdown types.

Images (the form can show pictures):
- To let the user CHOOSE among pictures, give each option an "image". select/multiselect then render as a grid of thumbnail cards (label and description under each); dropdown shows the selected option's image in its preview area. The answer is still the option label.
- To show pictures the user should COMMENT on or rate, put them in the question's "images" ([{ src, caption? }]); they appear under the question text. Pair with textarea/text for comments or select for a rating.
- An image src is an absolute file path, a path relative to your working directory, an http(s) URL, or a data:image/... URI. Local files are served by the dashboard; you do not need to upload or encode them. The user can click a zoom button to view any image full size.
- Markdown images (![alt](path)) in description, question and preview text accept the same src forms.

The answer for each question is returned as: { id, question, answer } where answer is a string, number, boolean, or string array depending on type. If the user cancels, the answer is { cancelled: true }.`,
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {
        type: 'string',
        description: 'Optional form title displayed at the top.',
        maxLength: 80,
      },
      description: {
        type: 'string',
        description: 'Optional description shown below the title. Supports markdown.',
      },
      submitLabel: {
        type: 'string',
        description: 'Custom submit button label. Defaults to "Submit".',
        maxLength: 30,
      },
      cancelLabel: {
        type: 'string',
        description: 'If set, shows a cancel button with this label. Cancel returns { cancelled: true }.',
        maxLength: 30,
      },
      questions: {
        type: 'array',
        description: 'Questions to ask the user (1-8 questions).',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for this question. Short kebab-case, e.g. "deploy-target".',
            },
            type: {
              type: 'string',
              enum: ['select', 'multiselect', 'text', 'textarea', 'number', 'toggle', 'dropdown', 'file', 'confirm'],
              description: 'The input type for this question.',
            },
            question: {
              type: 'string',
              description: 'The question text. Supports inline markdown.',
            },
            images: {
              type: 'array',
              description: 'Pictures shown under the question text, e.g. for the user to comment on or rate (pair with textarea, text or select). Up to 12.',
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  src: {
                    type: 'string',
                    description: 'Absolute file path, path relative to your working directory, http(s) URL, or data:image/... URI.',
                  },
                  caption: {
                    type: 'string',
                    description: 'Short caption shown under the picture. Defaults to its number (#1, #2, ...).',
                  },
                },
                required: ['src'],
              },
            },
            header: {
              type: 'string',
              description: 'Short label/chip shown above the question. Max 40 characters.',
              maxLength: 40,
            },
            required: {
              type: 'boolean',
              description: 'Whether this question must be answered. Defaults to true.',
            },
            placeholder: {
              type: 'string',
              description: 'Placeholder text for text, textarea, and number inputs.',
            },
            defaultValue: {
              description: 'Default value. For select/dropdown: option label string. For multiselect: array of label strings. For toggle/confirm: boolean. For number: number. For text/textarea: string.',
            },
            showIf: {
              type: 'object',
              description: 'Show this question only when a condition on a previous question is met.',
              additionalProperties: false,
              properties: {
                questionId: {
                  type: 'string',
                  description: 'The id of the question to check.',
                },
                equals: {
                  description: 'Show if the referenced answer equals this value.',
                },
                notEquals: {
                  description: 'Show if the referenced answer does not equal this value.',
                },
                includes: {
                  type: 'string',
                  description: 'Show if the referenced answer (array) includes this value.',
                },
              },
              required: ['questionId'],
            },
            options: {
              type: 'array',
              description: 'Options for select, multiselect, and dropdown types. 2-10 items.',
              minItems: 2,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: {
                    type: 'string',
                    description: 'Display text for this option.',
                  },
                  description: {
                    type: 'string',
                    description: 'Short explanation of this option.',
                  },
                  preview: {
                    type: 'string',
                    description: 'Preview content shown when this option is selected. Supports markdown/code blocks.',
                  },
                  image: {
                    type: 'string',
                    description: 'Picture for this option (select/multiselect: thumbnail card; dropdown: shown when selected). Absolute file path, path relative to your working directory, http(s) URL, or data:image/... URI. The answer is still the label.',
                  },
                },
                required: ['label'],
              },
            },
            min: {
              type: 'number',
              description: 'Minimum value for number type.',
            },
            max: {
              type: 'number',
              description: 'Maximum value for number type.',
            },
            step: {
              type: 'number',
              description: 'Step increment for number type.',
            },
            accept: {
              type: 'string',
              description: 'File type filter for file type, e.g. ".json,.yaml" or "image/*".',
            },
            multiple: {
              type: 'boolean',
              description: 'Allow multiple file selection for file type.',
            },
          },
          required: ['id', 'type', 'question'],
        },
      },
    },
    required: ['questions'],
  },
};

module.exports = enhancedAskTool;
