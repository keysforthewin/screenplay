export const TOOLS = [
  {
    name: 'list_characters',
    description: 'Return a list of all characters on file (id and name only). Use this to see what characters exist before creating a new one.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_character',
    description: 'Fetch the full document for one character by name (case-insensitive) or _id.',
    input_schema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: "Character's name or _id" } },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_character',
    description: 'Create a new character with at minimum the core fields. Returns the new character.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        plays_self: { type: 'boolean' },
        hollywood_actor: { type: 'string', description: 'Required when plays_self is false.' },
        own_voice: { type: 'boolean' },
        fields: {
          type: 'object',
          description: 'Any additional template-defined fields you have values for at creation time.',
          additionalProperties: true,
        },
      },
      required: ['name', 'plays_self', 'own_voice'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_character',
    description: 'Patch fields on an existing character. Only provide fields to change. Custom template fields go inside the `fields` object (e.g., {"fields": {"favorite_color": "blue"}}).',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string' },
        patch: { type: 'object', additionalProperties: true },
      },
      required: ['identifier', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_characters',
    description: 'Find characters whose fields contain a substring (case-insensitive).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_character_template',
    description: 'Return the current required and optional field schema for characters.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_character_template',
    description: 'Modify the character schema. Use when the user wants to add or remove fields from the universal template (e.g., "all characters should have favorite color"). Cannot remove core fields.',
    input_schema: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'snake_case field name' },
              description: { type: 'string' },
              required: { type: 'boolean' },
            },
            required: ['name', 'description', 'required'],
            additionalProperties: false,
          },
        },
        remove: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_plot',
    description: 'Return the current plot document (synopsis, beats, notes).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_plot',
    description: 'Modify the plot. To append to beats, fetch the current plot first and pass the combined array.',
    input_schema: {
      type: 'object',
      properties: {
        synopsis: { type: 'string' },
        beats: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              order: { type: 'number' },
              title: { type: 'string' },
              description: { type: 'string' },
              characters: { type: 'array', items: { type: 'string' } },
            },
            required: ['order', 'title', 'description'],
            additionalProperties: false,
          },
        },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export_pdf',
    description: 'Generate a PDF of the current characters + plot. The bot will upload the file to the channel automatically. Only call when the user asks to export.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Working title for the cover page' } },
      additionalProperties: false,
    },
  },
];
