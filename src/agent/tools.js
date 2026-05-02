export const TOOLS = [
  {
    name: 'tool_search',
    metaTool: true,
    description:
      'Load additional tools by describing what you want to do. Most of the agent\'s tools are NOT in your tools list by default — call this to make them available. The matched tools become callable in the SAME turn (re-issue the tool call after the search returns). Examples: "add image to beat", "export PDF", "look up movie credits", "delete character", "find similar work", "check repeated phrases". Categories: characters, beats, director_notes, images, attachments, plot, export, tmdb, web_search, analysis, utility, current_state. You may call tool_search multiple times in a turn as you discover what you need.',
    keywords: [
      'search', 'find', 'load', 'discover', 'lookup', 'tools', 'tool', 'available',
      'help', 'what', 'how', 'capability', 'feature',
    ],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text description of the action you want to take (e.g. "add image to beat", "export PDF", "find duplicate characters").',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Max tools to load. Default 8.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_overview',
    keywords: ['overview', 'summary', 'snapshot', 'rundown', 'state', 'everything', 'show', 'status', 'progress', 'where'],
    description: 'Single-call snapshot of EVERYTHING in the screenplay: synopsis + notes preview, every character (with casting, voice, fill ratio, image counts, one descriptive field preview), every beat (with name, full desc, body length, characters, image counts, current marker), and overall counts. Use this whenever the user asks for a summary, "show me everything", "what do we have", "what state is this in", "give me a rundown", "what beats need bodies", "which characters are missing images", or any other holistic question. Returns rich JSON; render it as markdown for Discord (the bot will auto-split long messages). Don\'t bombard the user with the entire payload — pick the angle that answers their question.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_characters',
    keywords: ['list', 'all', 'characters', 'people', 'cast', 'roles', 'show', 'enumerate'],
    description: 'Return a list of all characters on file (id and name only). Use this to see what characters exist before creating a new one.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_character',
    keywords: ['fetch', 'lookup', 'character', 'person', 'role', 'cast', 'details', 'profile', 'sheet'],
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
    keywords: ['create', 'new', 'add', 'make', 'introduce', 'character', 'person', 'role', 'cast', 'protagonist', 'antagonist', 'stub'],
    description: 'Create a new character. Only `name` is required — call this as soon as the user names someone, even if other fields aren\'t known yet. Defaults: plays_self=true, own_voice=true. Use `update_character` later to fill in details as the conversation provides them.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        plays_self: { type: 'boolean', description: 'Defaults to true if omitted.' },
        hollywood_actor: { type: 'string', description: 'Required when plays_self is false.' },
        own_voice: { type: 'boolean', description: 'Defaults to true if omitted.' },
        fields: {
          type: 'object',
          description: 'Any additional template-defined fields you have values for at creation time.',
          additionalProperties: true,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_character',
    keywords: ['update', 'edit', 'change', 'modify', 'patch', 'set', 'character', 'person', 'role', 'fix'],
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
    name: 'bulk_update_character_field',
    keywords: ['bulk', 'batch', 'mass', 'fill', 'populate', 'every', 'all', 'characters', 'field'],
    description:
      'Update ONE field across many characters in a SINGLE tool call. Use this — never fan out individual `update_character` calls — when the user asks to populate, set, or fill a field for "all", "every", or many characters (e.g. "give every character a role"). Decide each value in your reasoning, then submit them all here as one call. The handler writes them in batches and logs progress. `field_name` may be a core field (`name`, `plays_self`, `hollywood_actor`, `own_voice`) or any custom template field — custom fields are stored under `fields.<name>` automatically; do NOT prefix `fields.` yourself. Returns a summary listing successes and failures.',
    input_schema: {
      type: 'object',
      properties: {
        field_name: {
          type: 'string',
          description:
            'Field to set on each character. Core fields: name, plays_self, hollywood_actor, own_voice. Otherwise the field is stored under fields.<field_name>.',
        },
        updates: {
          type: 'array',
          minItems: 1,
          description: 'List of {character, value} pairs. One entry per character to update.',
          items: {
            type: 'object',
            properties: {
              character: {
                type: 'string',
                description: 'Character name (case-insensitive) or 24-char hex _id.',
              },
              value: {
                description: 'New value for the field. Type depends on the field.',
              },
            },
            required: ['character', 'value'],
            additionalProperties: false,
          },
        },
        batch_size: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Concurrent writes per batch. Default 10.',
        },
      },
      required: ['field_name', 'updates'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_character',
    keywords: ['delete', 'remove', 'drop', 'kill', 'destroy', 'wipe', 'character', 'person', 'role'],
    description:
      'Permanently delete a character. Cascades: removes the character from every beat\'s character list, deletes all of their portrait images (GridFS), and deletes all of their non-image attachments (GridFS). Use when the user says "delete", "remove", or "drop" a character. The deletion cannot be undone — confirm with the user first if there is any ambiguity about which character they mean.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: "Character's name (case-insensitive) or 24-char hex _id." },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_characters',
    keywords: ['search', 'find', 'lookup', 'character', 'person', 'role', 'substring', 'fuzzy'],
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
    keywords: ['template', 'schema', 'fields', 'character', 'structure', 'definition'],
    description: 'Return the current required and optional field schema for characters.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_character_template',
    keywords: ['template', 'schema', 'fields', 'character', 'modify', 'add', 'remove', 'change'],
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
    name: 'list_director_notes',
    keywords: ['list', 'director', 'notes', 'rules', 'directives', 'standing', 'show', 'all'],
    description: "Return the director's standing rules for this screenplay as an ordered array of {_id, text, created_at}. Director's notes are screenplay-wide directives that apply to every character and beat (e.g. \"unnamed extras are Feral Ewoks\", \"avoid anachronisms unless flagged\"). Call this when the user asks to see the rules in force, or before editing/removing/reordering to learn the current ids and order.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_director_note',
    keywords: ['add', 'create', 'new', 'director', 'note', 'rule', 'directive', 'standing', 'screenplay-wide'],
    description: "Append a new screenplay-wide rule to the director's notes. Use this when the user states a directive that applies to the screenplay overall but does NOT belong on a specific character or beat — e.g. \"from now on all unnamed extras are Feral Ewoks\", \"keep the tone deadpan\", \"no anachronisms unless I flag them\". Do NOT use this for character-specific facts (use update_character) or beat-specific content (use update_beat / append_to_beat_body). Returns a status string with the new note's _id.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The rule, as a single bullet (one or two short sentences).' },
        position: {
          type: 'integer',
          description: 'Optional 0-based index to insert at. Omit to append to the end.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_director_note',
    keywords: ['edit', 'update', 'change', 'modify', 'director', 'note', 'rule', 'directive', 'revise'],
    description: "Replace the text of an existing director's note, identified by its _id. Use when the user wants to revise a rule (\"change the Ewok rule to Wookiees\") rather than add a new one. Returns a status string. To find the right _id, call list_director_notes first.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note to edit.' },
        text: { type: 'string', description: 'New text for the note.' },
      },
      required: ['note_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_director_note',
    keywords: ['remove', 'delete', 'drop', 'forget', 'director', 'note', 'rule', 'directive'],
    description: "Delete a director's note by _id. Use when the user retracts a rule (\"forget the anachronisms thing\"). To find the right _id, call list_director_notes first.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note to remove.' },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reorder_director_notes',
    keywords: ['reorder', 'rearrange', 'sort', 'priority', 'director', 'notes', 'rules'],
    description: "Replace the order of the director's notes with a new permutation. Pass note_ids as an array containing every existing note's _id exactly once, in the desired new order. Use when the user wants to change priority (\"the Ewok rule should be first\"). To find the current ids, call list_director_notes first.",
    input_schema: {
      type: 'object',
      properties: {
        note_ids: {
          type: 'array',
          items: { type: 'string', description: '24-char hex _id of a note.' },
          description: 'All current note _ids in the desired new order. Must contain every existing note _id exactly once.',
        },
      },
      required: ['note_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_director_note_image',
    keywords: ['image', 'picture', 'photo', 'visual', 'attach', 'add', 'director', 'note', 'rule'],
    description:
      "Attach an image (PNG, JPG, or WEBP, up to 25 MB) to a director's note. The image is downloaded from `source_url` and stored in MongoDB GridFS (the `images` bucket). `source_url` may be either (a) one of the URLs listed in the \"Attached images\" prelude when the user uploaded an image via the Discord client, or (b) a public HTTP(S) URL the user pasted into chat. The first image attached to a note auto-becomes its main; pass `set_as_main: true` to override an existing main. Use when the user wants visual reference attached to a screenplay-wide rule (e.g., a colour palette swatch on a \"keep the palette muted\" note). Find the right note_id with list_director_notes.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        source_url: { type: 'string', description: 'HTTP(S) URL to the image' },
        filename: { type: 'string' },
        caption: { type: 'string' },
        set_as_main: { type: 'boolean' },
      },
      required: ['note_id', 'source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_director_note_images',
    keywords: ['list', 'images', 'pictures', 'photos', 'director', 'note', 'rule'],
    description: "List the images attached to a director's note (filenames, sizes, content types, captions, source, and which one is currently the main image).",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_main_director_note_image',
    keywords: ['main', 'primary', 'featured', 'image', 'director', 'note', 'rule', 'promote'],
    description: "Promote an existing image to be the note's main image. The image_id must already be attached to the note (use list_director_note_images to find it).",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['note_id', 'image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_director_note_image',
    keywords: ['remove', 'delete', 'image', 'picture', 'director', 'note', 'rule'],
    description: "Delete an image from a director's note. Removes both the GridFS file and the entry on the note. If the deleted image was the main image, the next image (if any) is promoted automatically.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['note_id', 'image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_library_image_to_director_note',
    keywords: ['attach', 'library', 'image', 'picture', 'director', 'note', 'rule', 'assign'],
    description: "Attach a library image (one with no current owner) to a director's note. The image is moved out of the library — list_library_images will no longer show it. If `set_as_main` is true, the image becomes the note's main image.",
    input_schema: {
      type: 'object',
      properties: {
        image_id: { type: 'string' },
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        set_as_main: { type: 'boolean' },
      },
      required: ['image_id', 'note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_director_note_attachment',
    keywords: ['add', 'attach', 'file', 'audio', 'video', 'pdf', 'document', 'director', 'note', 'rule'],
    description:
      "Attach a NON-IMAGE file (audio, video, PDF, text, archive — anything up to 100 MB) to a director's note. The file is downloaded from `source_url` and stored in MongoDB GridFS (the `attachments` bucket). Use this for files in the \"Attached files:\" prelude (NOT the \"Attached images:\" prelude — those go through `add_director_note_image` instead). Useful for reference docs or audio that backs a screenplay-wide directive (e.g., a tone-of-voice sample on a \"keep the dialect Appalachian\" note).",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        source_url: { type: 'string', description: 'HTTP(S) URL to the file' },
        filename: { type: 'string' },
        caption: { type: 'string', description: 'Optional short note about why this file is attached.' },
      },
      required: ['note_id', 'source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_director_note_attachments',
    keywords: ['list', 'files', 'attachments', 'documents', 'director', 'note', 'rule'],
    description: "List the non-image files attached to a director's note (filenames, sizes, content types, captions). Image attachments are listed separately by list_director_note_images.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_director_note_attachment',
    keywords: ['remove', 'delete', 'file', 'attachment', 'director', 'note', 'rule'],
    description: "Delete a non-image attachment from a director's note. Removes the GridFS file and the entry on the note.",
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['note_id', 'attachment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_plot',
    keywords: ['plot', 'synopsis', 'story', 'overview', 'outline', 'summary', 'main'],
    description: 'Return the current plot document (synopsis, beats, notes, current_beat_id).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_plot',
    keywords: ['plot', 'synopsis', 'story', 'update', 'edit', 'change', 'modify', 'notes'],
    description: 'Modify the plot synopsis or notes. To work with beats, use the dedicated beat tools (list_beats, get_beat, create_beat, update_beat, delete_beat) — this tool does not edit beats.',
    input_schema: {
      type: 'object',
      properties: {
        synopsis: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_beats',
    keywords: ['list', 'all', 'beats', 'scenes', 'moments', 'show', 'enumerate', 'outline'],
    description: 'Return a compact list of all beats with id, order, name, a short desc preview, body length, character count, image count, and whether each is the current beat. Sorted by order. For substring/fuzzy lookup across name+desc+body, use search_beats instead.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_beat',
    keywords: ['fetch', 'beat', 'scene', 'moment', 'lookup', 'details'],
    description: 'Fetch the full beat document (name, desc, body, characters, images, main_image_id). If no identifier is provided, returns the current beat (or null if none is set). Identifier accepts a beat _id (24-char hex), an order number as a string, or a beat name (case-insensitive exact match). For fuzzy matches like "the diner one" use search_beats first.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Beat _id, order, or name. Omit to use the current beat.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_beats',
    keywords: ['search', 'find', 'beat', 'scene', 'moment', 'fuzzy', 'lookup', 'substring'],
    description: 'Substring search across beat name, desc, and body (case-insensitive). Returns ranked candidates so you can disambiguate when the user gestures at a beat ("the diner argument", "that scene where Alice leaves"). Use this before set_current_beat / update_beat when the user references a beat by description rather than an exact name. Each result is { _id, order, name, desc_preview, matched_field, score }.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to look for in name, desc, or body.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_beat',
    keywords: ['create', 'new', 'add', 'make', 'beat', 'scene', 'moment', 'introduce'],
    description: 'Create a new beat. A beat has THREE text fields: `name` (short identifier, ~3-6 words), `desc` (1-2 sentence summary set on creation — the elevator pitch for the beat), and `body` (long-form developing content that grows over time as the user adds lore). Always pass `desc`. You SHOULD pass `name` too — generate a concise title-cased phrase from the user\'s description (e.g., "Diner Argument", "Alice Confronts Bob"). If `name` is omitted the system derives one from `desc`. Pass `body` only if the user gave you initial body content; otherwise leave it empty and use append_to_beat_body later. The first beat created automatically becomes the current beat.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short identifier (3-6 words). Generate from the user\'s prose.' },
        desc: { type: 'string', description: '1-2 sentence summary of what the beat is about.' },
        body: { type: 'string', description: 'Optional initial long-form content. Usually omit on creation; add later with append_to_beat_body.' },
        characters: { type: 'array', items: { type: 'string' }, description: 'Names of characters present in this beat.' },
        order: { type: 'number', description: 'Optional explicit order. Omit to append.' },
      },
      required: ['desc'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_beat',
    keywords: ['update', 'edit', 'change', 'modify', 'patch', 'beat', 'scene', 'moment', 'fix'],
    description: 'Patch fields on an existing beat. Only provide fields to change. NOTE: `body` here REPLACES the existing body — to add to body without overwriting, use append_to_beat_body instead. To replace characters, pass the full new array.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Beat _id, order, or name.' },
        patch: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            desc: { type: 'string' },
            body: { type: 'string', description: 'REPLACES existing body. Use append_to_beat_body to append.' },
            order: { type: 'number' },
            characters: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      required: ['identifier', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_beat_body',
    keywords: ['append', 'add', 'extend', 'beat', 'scene', 'moment', 'body', 'content', 'lore', 'more'],
    description: 'Append content to a beat\'s `body` field without overwriting. Inserts a blank-line separator between the existing body and the new content. Prefer this over update_beat when the user is dumping additional lore onto an existing beat ("also, in this scene Bob says X..." → append). If `beat` is omitted, the current beat is used.',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use the current beat.' },
        content: { type: 'string', description: 'Text to append to the beat body.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_beat',
    keywords: ['delete', 'remove', 'drop', 'destroy', 'beat', 'scene', 'moment'],
    description: 'Delete a beat and any images attached to it. If the deleted beat was the current beat, the current pointer is cleared.',
    input_schema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: 'Beat _id, order, or name.' } },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'link_character_to_beat',
    keywords: ['link', 'add', 'attach', 'connect', 'character', 'beat', 'scene', 'present'],
    description: "Add a character (by name) to a beat's character list. Idempotent — duplicates are silently ignored. If `beat` is omitted, the current beat is used.",
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
        character: { type: 'string' },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlink_character_from_beat',
    keywords: ['unlink', 'remove', 'detach', 'character', 'beat', 'scene'],
    description: "Remove a character from a beat's character list. If `beat` is omitted, the current beat is used.",
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string' },
        character: { type: 'string' },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_current_beat',
    keywords: ['set', 'current', 'focus', 'beat', 'scene', 'pointer', 'switch'],
    description: 'Set the bot\'s "current beat" pointer. Tools that take an optional `beat` argument default to this one. Useful when the user is focused on a specific beat (e.g., "let\'s work on the diner scene").',
    input_schema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: 'Beat _id, order, or name.' } },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_beat',
    keywords: ['current', 'focus', 'beat', 'scene', 'pointer', 'which', 'now'],
    description: 'Return the current beat (full document) or null if none is set.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'clear_current_beat',
    keywords: ['clear', 'unset', 'reset', 'current', 'focus', 'beat', 'pointer'],
    description: 'Clear the current-beat pointer. After this, tools that default to the current beat will require an explicit identifier.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_beat_image',
    keywords: ['attach', 'add', 'upload', 'image', 'picture', 'photo', 'art', 'illustration', 'visual', 'still', 'storyboard', 'beat', 'scene'],
    description:
      'Attach an image (PNG, JPG, or WEBP, up to 25 MB) to a beat. The image is downloaded from `source_url` and stored in MongoDB GridFS (the `images` bucket). `source_url` may be either (a) one of the URLs listed in the "Attached images" prelude when the user uploaded an image via the Discord client, or (b) a public HTTP(S) URL the user pasted into chat. The first image attached to a beat automatically becomes its main image; pass `set_as_main: true` to override an existing main image. If `beat` is omitted, the current beat is used.',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
        source_url: { type: 'string', description: 'HTTP(S) URL to the image' },
        filename: { type: 'string' },
        caption: { type: 'string' },
        set_as_main: { type: 'boolean' },
      },
      required: ['source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_beat_images',
    keywords: ['list', 'show', 'images', 'pictures', 'photos', 'beat', 'scene'],
    description: 'List the images attached to a beat (filenames, sizes, types, source, generation prompt if any, and which one is currently the main image).',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_main_beat_image',
    keywords: ['main', 'primary', 'featured', 'image', 'beat', 'scene', 'promote'],
    description: "Promote an existing image to be the beat's main image. The image_id must already be attached to the beat (use list_beat_images to find it).",
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string' },
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_beat_image',
    keywords: ['remove', 'delete', 'image', 'picture', 'photo', 'beat', 'scene'],
    description: "Delete an image from a beat. Removes both the GridFS file and the entry on the beat. If the deleted image was the main image, the next image (if any) is promoted automatically.",
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string' },
        image_id: { type: 'string' },
      },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_library_images',
    keywords: ['library', 'unassigned', 'images', 'pictures', 'list', 'show', 'orphan', 'pool'],
    description: 'List unassigned (library) images — images that have been uploaded or generated but are not yet attached to any beat. Useful when the user says "save that image to the diner beat" and you need to find the image_id.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'attach_library_image_to_beat',
    keywords: ['attach', 'library', 'image', 'picture', 'beat', 'scene', 'assign'],
    description: "Attach a library image (one with no current beat owner) to a beat. The image is moved out of the library — list_library_images will no longer show it. If `beat` is omitted, the current beat is used. If `set_as_main` is true, the image becomes the beat's main image.",
    input_schema: {
      type: 'object',
      properties: {
        image_id: { type: 'string' },
        beat: { type: 'string' },
        set_as_main: { type: 'boolean' },
      },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_library_attachment',
    keywords: ['library', 'upload', 'add', 'file', 'audio', 'video', 'pdf', 'document', 'unassigned', 'stash'],
    description:
      "Upload a non-image file (audio, video, PDF, text, archive — anything up to 100 MB) to the library with no owner. The file is downloaded from `source_url` and stored in MongoDB GridFS — `list_library_attachments` will show it, and you can later attach it to one or more entities with `attach_library_attachment_to_{beat,character,director_note}`. Use this when the user wants to upload a file once and then attach it to multiple beats/characters/notes, or wants to stash a file before deciding where it goes. For images, do NOT use this tool — use the entity-specific add_*_image tools or generate_image (which writes to the library by default when no current beat is set).",
    input_schema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'HTTP(S) URL to the file' },
        filename: { type: 'string', description: 'Optional filename to store. Defaults to the URL basename.' },
        caption: { type: 'string', description: 'Optional short note about the file (kept on the GridFS metadata, not on any entity).' },
      },
      required: ['source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_library_attachments',
    keywords: ['library', 'list', 'unassigned', 'files', 'attachments', 'documents'],
    description: 'List unassigned (library) non-image attachments — files uploaded with `add_library_attachment` that are not yet attached to any beat, character, or director note. Useful when the user says "attach that PDF to the Diner Showdown beat" and you need to find the attachment_id.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'attach_library_attachment_to_beat',
    keywords: ['attach', 'library', 'file', 'attachment', 'beat', 'scene', 'assign'],
    description: 'Attach a library attachment (one with no current owner) to a beat. The attachment is moved out of the library — `list_library_attachments` will no longer show it. If `beat` is omitted, the current beat is used.',
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex) of the library attachment' },
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
        caption: { type: 'string', description: 'Optional caption to store on the beat-side entry.' },
      },
      required: ['attachment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_library_attachment_to_character',
    keywords: ['attach', 'library', 'file', 'attachment', 'character', 'person', 'assign'],
    description: "Attach a library attachment (one with no current owner) to a character. The attachment is moved out of the library — `list_library_attachments` will no longer show it.",
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex) of the library attachment' },
        character: { type: 'string', description: "Character's name or _id" },
        caption: { type: 'string' },
      },
      required: ['attachment_id', 'character'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_library_attachment_to_director_note',
    keywords: ['attach', 'library', 'file', 'attachment', 'director', 'note', 'rule', 'assign'],
    description: "Attach a library attachment (one with no current owner) to a director's note. The attachment is moved out of the library — `list_library_attachments` will no longer show it.",
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex) of the library attachment' },
        note_id: { type: 'string', description: '24-char hex _id of the note.' },
        caption: { type: 'string' },
      },
      required: ['attachment_id', 'note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_image',
    keywords: ['show', 'display', 'view', 'see', 'image', 'picture', 'photo', 'render', 'embed'],
    description: 'Display an existing image (any image_id — whether attached to a beat, attached to a character as a portrait, or sitting in the library) by attaching it to the bot\'s reply in Discord. Use when the user asks to "see" or "show" an image.',
    input_schema: {
      type: 'object',
      properties: { image_id: { type: 'string' } },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_image',
    keywords: ['describe', 'analyze', 'examine', 'inspect', 'look', 'image', 'picture', 'vision', 'traits', 'extract'],
    description:
      "Load a stored image into your own vision context so you can actually look at the pixels and describe what is depicted. Use this whenever you (or the user) need a fresh, detailed description of an image — especially to extract character physical traits (hair color, hair length, hairstyle, build, eye color, clothing, etc.) so the character can be regenerated faithfully later. Unlike show_image (which only ships the file to Discord), this tool returns the image bytes to you so you can see them. Pass an optional `prompt` to focus the analysis on a specific question; the baseline character-appearance analysis still runs.",
    input_schema: {
      type: 'object',
      properties: {
        image_id: {
          type: 'string',
          description: '24-hex GridFS file id of the image to analyze.',
        },
        prompt: {
          type: 'string',
          description:
            "Optional focused question or instruction (e.g. 'compare hair color to the previous portrait'). Combined with the baseline character-appearance prompt — does not replace it.",
        },
      },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_attachment',
    keywords: ['show', 'display', 'send', 'retrieve', 'file', 'attachment', 'audio', 'video', 'pdf', 'document'],
    description: "Re-deliver a stored non-image attachment (any attachment_id from a beat, character, or director's note) by uploading it to the Discord reply. Use when the user asks to retrieve a file they previously attached (\"send me back that recording\", \"give me the PDF I attached to that beat\"). For images, use show_image instead.",
    input_schema: {
      type: 'object',
      properties: { attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex)' } },
      required: ['attachment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_image',
    keywords: ['generate', 'create', 'draw', 'render', 'make', 'ai', 'nano', 'banana', 'image', 'picture', 'illustration', 'art', 'visual', 'gemini'],
    description:
      'Generate an image with Google\'s "Nano Banana" (gemini-2.5-flash-image). The bot will display the generated image in its reply. ONLY call this when the user has explicitly asked for an image (e.g., "draw this", "generate an image of...", "show me what this looks like"). Compose the prompt from one or more of: an explicit `prompt` string, the current/named beat (set `include_beat: true`), or recent conversation context (set `include_recent_chat: true`). At least one of these inputs must be provided.\n\nDestination precedence (the image is owned by exactly one entity, or none): (1) `attach_to_character` wins; (2) else `attach_to_beat` (any beat, not just current); (3) else `attach_to_current_beat` (default true when a current beat is set); (4) else the library — where it can be attached later via `attach_library_image_to_{character,beat,director_note}`. `attach_to_character` and `attach_to_beat` are mutually exclusive. `set_as_main` applies to whichever target is chosen. Returns the image_id and displays the image. Requires GEMINI_API_KEY to be configured.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Free-form prompt fragment to include verbatim.' },
        include_beat: { type: 'boolean', description: 'When true, weave the beat\'s name/desc/body/characters into the prompt.' },
        beat: { type: 'string', description: 'Identifier for the beat to draw from when include_beat is true. Defaults to the current beat. Use `attach_to_beat` to also bind the generated image to a beat.' },
        include_recent_chat: { type: 'boolean', description: 'When true, include a short summary of recent conversation in the prompt.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Optional aspect ratio. Defaults to 16:9.' },
        attach_to_current_beat: { type: 'boolean', description: 'Default true when a current beat is set; false otherwise. When false, the image lands in the library (unless `attach_to_character` / `attach_to_beat` is set). Ignored when either of those is set.' },
        attach_to_character: { type: 'string', description: "Character name or 24-char hex _id. When set, the generated image is owned by this character (pushed onto its images[]). Mutually exclusive with attach_to_beat." },
        attach_to_beat: { type: 'string', description: "Beat _id, order, or name to bind the generated image to. Overrides attach_to_current_beat. Mutually exclusive with attach_to_character." },
        set_as_main: { type: 'boolean', description: "If true, the generated image becomes the chosen entity's main image (or, with no target, this flag has no effect)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_image',
    keywords: ['edit', 'modify', 'change', 'tweak', 'update', 'alter', 'image', 'picture', 'variant', 'iterate', 'remix'],
    description:
      'Edit an existing image with NanoBanana (gemini-2.5-flash-image). Pass the source `image_id` and a `prompt` describing the change ("give him blonde hair", "make it nighttime", "remove the hat"). Result is saved as a new GridFS image owned by whatever the source belonged to (character / beat / director_note / library); when the source was that owner\'s main image, the result is automatically promoted to the new main image. Use this whenever the user asks to modify, change, tweak, or update an existing image rather than create a fresh one.\n\nYou MUST decide whether to delete the source image after editing: pass `replace_source: true` when the user wants the old version gone (e.g. "change his hair to blonde", "update the main image so..."), or `replace_source: false` when they\'re iterating, comparing, or want a variant ("try a version where...", "give me an alternate with..."). When in doubt, prefer `false` so nothing is destroyed. Optional `attach_to_character` / `attach_to_beat` / `set_as_main` overrides have the same meaning as in `generate_image` and let you redirect the result away from the source\'s owner.',
    input_schema: {
      type: 'object',
      properties: {
        source_image_id: { type: 'string', description: '24-char hex GridFS file id of the image to edit. Get this from list_character_images, the beat\'s images[], or director-note image listings.' },
        prompt: { type: 'string', description: 'Concise instruction describing the change to make (e.g., "give him blonde hair instead of black"). Will be sent to NanoBanana alongside the source image.' },
        replace_source: { type: 'boolean', description: 'REQUIRED. true = delete the source image after a successful edit (truly "in place"); false = keep the source alongside the new image so the user can compare or revert.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Optional reframing. Omit to preserve the source image\'s framing.' },
        attach_to_character: { type: 'string', description: 'Override: attach the edited result to this character instead of the source\'s owner. Mutually exclusive with attach_to_beat.' },
        attach_to_beat: { type: 'string', description: 'Override: attach the edited result to this beat instead of the source\'s owner. Mutually exclusive with attach_to_character.' },
        set_as_main: { type: 'boolean', description: "Whether the edited image becomes its owner's main_image_id. Defaults to true when the source was its owner's main image; defaults to false otherwise. Pass an explicit value to override." },
      },
      required: ['source_image_id', 'prompt', 'replace_source'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_pdf',
    keywords: ['export', 'download', 'save', 'pdf', 'document', 'screenplay', 'print', 'snapshot', 'compile', 'render'],
    description: "Generate a PDF and upload it to the channel. With no filters, exports the full screenplay (cover, director's notes, all characters, plot, library). Pass at most one filter to narrow the output: `characters` for a character-sheets-only PDF, `beats_query` for a beats-only PDF matching a search, or `dossier_character` for one character's sheet plus every beat they appear in. Only call when the user asks to export.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Working title for the cover page.' },
        characters: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Character names or 24-hex IDs. Output contains ONLY these character sheets — no plot, director\'s notes, or library.',
        },
        beats_query: {
          type: 'string',
          description: 'Substring search across beat name/desc/body (same scoring as the search_beats tool). Output contains ONLY matching beats — no characters, director\'s notes, or library.',
        },
        dossier_character: {
          type: 'string',
          description: 'Character name or 24-hex ID. Output is that character\'s sheet plus every beat where they appear in beat.characters[] (case-insensitive). No other characters, director\'s notes, or library.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export_csv',
    keywords: ['export', 'csv', 'spreadsheet', 'table', 'data', 'report', 'download', 'save', 'tabular'],
    description:
      'Build a spreadsheet-style CSV report of characters or beats. Pick columns by dot-path field name (e.g. "name", "fields.background_story") or by computed pseudo-field. Computed fields for characters: image_count, field_count, appears_in_beats. Computed fields for beats: word_count, char_count, image_count, attachment_count, character_count. Filter rows with structured operators (eq, ne, gt, gte, lt, lte, contains, exists), ANDed together. Optionally group_by + per-column aggregate (sum, avg, min, max, count): when group_by is set, every column must either be in group_by or have a non-none aggregate; when aggregates are present without group_by, the result is a single summary row over all matched rows. Sort and limit are applied last. The CSV is delivered as a Discord file attachment.',
    input_schema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          enum: ['characters', 'beats'],
          description: 'Which corpus to export.',
        },
        columns: {
          type: 'array',
          minItems: 1,
          description: 'Columns in output order.',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description:
                  'Dot-path into the document (e.g. "name", "plays_self", "fields.background_story") OR a computed pseudo-field name.',
              },
              header: {
                type: 'string',
                description:
                  'Optional CSV column header. Defaults to the field path, or "agg(field)" when aggregated.',
              },
              aggregate: {
                type: 'string',
                enum: ['none', 'sum', 'avg', 'min', 'max', 'count'],
                description:
                  "Default 'none'. 'count' counts non-null values; sum/avg/min/max coerce values via Number() and skip NaN.",
              },
            },
            required: ['field'],
            additionalProperties: false,
          },
        },
        filter: {
          type: 'array',
          description: 'Conditions ANDed together. Omit for no filtering.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: {
                type: 'string',
                enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'],
              },
              value: {
                description:
                  "For 'exists' a boolean; for 'contains' a string (case-insensitive substring; works on string fields and on array fields by element); for comparisons match the field's type.",
              },
            },
            required: ['field', 'op'],
            additionalProperties: false,
          },
        },
        group_by: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Field paths to group by. When set, every column must be in group_by or have a non-none aggregate.',
        },
        sort: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Column field path.' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
            },
            required: ['field'],
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: 5000 },
        filename: {
          type: 'string',
          description:
            'Optional output filename. Defaults to "${entity}-${YYYY-MM-DD}.csv". Sanitized to alphanumerics, dashes, underscores, dots.',
        },
      },
      required: ['entity', 'columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_character_image',
    keywords: ['attach', 'add', 'upload', 'image', 'picture', 'photo', 'portrait', 'headshot', 'art', 'character', 'person'],
    description:
      'Attach an image (PNG, JPG, or WEBP, up to 25 MB) to a character. The image is downloaded from `source_url` and stored in MongoDB GridFS. `source_url` may be either (a) one of the URLs listed in the "Attached images" prelude when the user uploaded an image via the Discord client, or (b) a public HTTP(S) URL the user pasted into chat. The first image attached to a character automatically becomes its main image; pass `set_as_main: true` to override an existing main image.',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id" },
        source_url: { type: 'string', description: 'HTTP(S) URL to the image' },
        filename: { type: 'string', description: 'Optional filename to store (recommended for URL-input cases without a clean filename)' },
        caption: { type: 'string', description: 'Optional short caption' },
        set_as_main: { type: 'boolean', description: 'If true, mark this image as the character\'s main image' },
      },
      required: ['character', 'source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_character_images',
    keywords: ['list', 'show', 'images', 'pictures', 'photos', 'portraits', 'character', 'person'],
    description: 'List the images attached to a character, including filenames, sizes, content types, and which one is currently the main image.',
    input_schema: {
      type: 'object',
      properties: { character: { type: 'string', description: "Character's name or _id" } },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_main_character_image',
    keywords: ['main', 'primary', 'featured', 'portrait', 'image', 'character', 'person', 'promote'],
    description: "Promote an existing image to be the character's main image. The image_id must already be attached to the character (use list_character_images to find it).",
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id" },
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['character', 'image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_character_image',
    keywords: ['remove', 'delete', 'image', 'picture', 'portrait', 'character', 'person'],
    description: 'Delete an image from a character. Removes the GridFS file and the entry from the character. If the deleted image was the main image, the next image (if any) is promoted automatically.',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id" },
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['character', 'image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'attach_library_image_to_character',
    keywords: ['attach', 'library', 'image', 'picture', 'portrait', 'character', 'person', 'assign'],
    description:
      "Attach a library image (one with no current owner) to a character. The image is moved out of the library — list_library_images will no longer show it. If `set_as_main` is true (or this is the character's first image), the image becomes the character's main image. Use this when the user wants a previously generated or library image used as a portrait.",
    input_schema: {
      type: 'object',
      properties: {
        image_id: { type: 'string', description: 'GridFS file _id (24-char hex) of the library image' },
        character: { type: 'string', description: "Character's name or _id" },
        set_as_main: { type: 'boolean' },
        caption: { type: 'string', description: 'Optional short caption' },
      },
      required: ['image_id', 'character'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_beat_attachment',
    keywords: ['attach', 'add', 'upload', 'file', 'audio', 'video', 'pdf', 'document', 'recording', 'transcript', 'beat', 'scene'],
    description:
      'Attach a NON-IMAGE file (audio, video, PDF, text, archive — anything up to 100 MB) to a beat. The file is downloaded from `source_url` and stored in MongoDB GridFS (the `attachments` bucket). Use this for files that arrive in the "Attached files:" prelude (NOT the "Attached images:" prelude — those go through `add_beat_image` instead). `source_url` may be either (a) one of the URLs listed in the "Attached files" prelude when the user uploaded a file via the Discord client, or (b) a public HTTP(S) URL the user pasted into chat. If `beat` is omitted, the current beat is used.',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
        source_url: { type: 'string', description: 'HTTP(S) URL to the file' },
        filename: { type: 'string', description: 'Optional filename to store. Defaults to the URL basename or `attachment.<ext>`.' },
        caption: { type: 'string', description: 'Optional short note about why this file is attached (e.g., "use for the PAULY IS FULL DEEP line").' },
      },
      required: ['source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_beat_attachments',
    keywords: ['list', 'show', 'files', 'attachments', 'documents', 'beat', 'scene'],
    description: 'List the non-image files attached to a beat (filenames, sizes, content types, captions). Image attachments are listed separately by `list_beat_images`.',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_beat_attachment',
    keywords: ['remove', 'delete', 'file', 'attachment', 'beat', 'scene'],
    description: 'Delete a non-image attachment from a beat. Removes both the GridFS file and the entry on the beat.',
    input_schema: {
      type: 'object',
      properties: {
        beat: { type: 'string', description: 'Beat _id, order, or name. Omit to use current.' },
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['attachment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_character_attachment',
    keywords: ['attach', 'add', 'upload', 'file', 'audio', 'video', 'pdf', 'document', 'recording', 'character', 'person'],
    description:
      'Attach a NON-IMAGE file (audio, video, PDF, text, archive — anything up to 100 MB) to a character. The file is downloaded from `source_url` and stored in MongoDB GridFS. Use this for files that arrive in the "Attached files:" prelude (NOT the "Attached images:" prelude — those go through `add_character_image` instead).',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id" },
        source_url: { type: 'string', description: 'HTTP(S) URL to the file' },
        filename: { type: 'string', description: 'Optional filename to store.' },
        caption: { type: 'string', description: 'Optional short note about why this file is attached.' },
      },
      required: ['character', 'source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_character_attachments',
    keywords: ['list', 'show', 'files', 'attachments', 'documents', 'character', 'person'],
    description: 'List the non-image files attached to a character (filenames, sizes, content types, captions). Image attachments are listed separately by `list_character_images`.',
    input_schema: {
      type: 'object',
      properties: { character: { type: 'string', description: "Character's name or _id" } },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_character_attachment',
    keywords: ['remove', 'delete', 'file', 'attachment', 'character', 'person'],
    description: 'Delete a non-image attachment from a character. Removes the GridFS file and the entry from the character.',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id" },
        attachment_id: { type: 'string', description: 'GridFS file _id (24-char hex)' },
      },
      required: ['character', 'attachment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tmdb_search_movie',
    keywords: ['tmdb', 'movie', 'film', 'lookup', 'search', 'find', 'real', 'database'],
    description: 'Search TheMovieDB for movies by title. Returns up to 5 candidates with id, title, year, a short overview preview, and poster_url. Use this first when the user mentions a real movie by name so you can ground subsequent calls (tmdb_get_movie, tmdb_get_movie_credits) on a specific movie_id.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Movie title (or partial title) to search for.' },
        year: { type: 'number', description: 'Optional release year to disambiguate.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'tmdb_get_movie',
    keywords: ['tmdb', 'movie', 'film', 'plot', 'cast', 'details', 'real'],
    description: 'Fetch full details for a TMDB movie: title, year, full overview/plot, runtime, genres, director, top 8 cast members (with character names, actor names, person_id, and photo_url), and poster_url. Use after tmdb_search_movie when the user asks for a plot summary or casting overview.',
    input_schema: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: 'TMDB movie id from tmdb_search_movie.' },
      },
      required: ['movie_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tmdb_get_movie_credits',
    keywords: ['tmdb', 'movie', 'film', 'cast', 'credits', 'actors', 'starred', 'played', 'role'],
    description: 'Fetch the full cast list for a TMDB movie, ordered by billing. Each entry has character (name played), actor_name, person_id, photo_url, and order. Use this when the user asks "who played [X] in this movie?" — scan results for a case-insensitive match on character.',
    input_schema: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: 'TMDB movie id from tmdb_search_movie.' },
      },
      required: ['movie_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tmdb_search_person',
    keywords: ['tmdb', 'actor', 'actress', 'person', 'celebrity', 'star', 'find', 'search', 'real'],
    description: 'Search TheMovieDB for people (actors, directors, crew) by name. Returns up to 5 candidates with id, name, known_for_titles (sample of films), and photo_url.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Person name or partial name.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'tmdb_show_image',
    keywords: ['tmdb', 'show', 'display', 'poster', 'headshot', 'image', 'picture', 'movie', 'actor'],
    description: 'Display a TMDB image (poster or actor headshot) by URL. Pass a `url` from tmdb_get_movie / tmdb_get_movie_credits / tmdb_search_person results — the URL must be on image.tmdb.org. The image is downloaded and attached to the bot reply in Discord.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'TMDB image URL (must be on image.tmdb.org).' },
        caption: { type: 'string', description: 'Optional short caption to send alongside the image.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'tavily_search',
    keywords: ['web', 'internet', 'google', 'tavily', 'search', 'lookup', 'browse', 'research', 'news'],
    description:
      'Search the live web via Tavily. Returns an LLM-friendly answer summary, top-ranked results (title, url, snippet), and related image URLs with descriptions. Use for real-world people, current events, historical topics, or to enrich TMDB lookups (you can call this and tmdb_* tools in the same turn). If TAVILY_API_KEY is not configured, returns a friendly error.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        max_results: {
          type: 'number',
          description: 'How many results to return. Default 5, max 10.',
        },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description:
            "'advanced' (default) returns better-curated content chunks at 2 credits/call; 'basic' is 1 credit/call and fine for casual lookups.",
        },
        topic: {
          type: 'string',
          enum: ['general', 'news'],
          description: "Use 'news' to bias toward recent news sources.",
        },
        time_range: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Restrict results to the given recency window.',
        },
        include_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only return results from these domains (e.g. ["wikipedia.org"]).',
        },
        exclude_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Drop results from these domains.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'tavily_show_image',
    keywords: ['tavily', 'web', 'show', 'display', 'image', 'picture', 'photo', 'search'],
    description:
      'Download an image URL returned by tavily_search and display it in Discord. Validates protocol, size (≤25 MB), and content type. Optional caption is shown alongside. Do not pass non-image URLs — they will be rejected.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Image URL from a tavily_search result.' },
        caption: { type: 'string', description: 'Optional caption shown with the image.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_repeated_phrases',
    keywords: ['repetition', 'overuse', 'redundant', 'tic', 'cliche', 'phrase', 'ngram', 'analysis', 'writing', 'check'],
    description:
      'Scan all beats for overused multi-word phrases (n-grams) — the kind of writing tics that are hard to see while drafting. Returns a ranked list of repeated phrases with their counts and the beats they appear in. Use when the user asks "what am I overusing?", "scan for repetition", "is my writing repetitive?", or proactively suggest it once there are 10+ beats. Skips phrases composed entirely of stopwords. Reports a low-signal warning when fewer than ~10 beats exist (the result is still computed, just less reliable).',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['name', 'desc', 'body'] },
          description: 'Which beat text fields to scan. Default ["desc", "body"].',
        },
        sizes: {
          type: 'array',
          items: { type: 'integer', minimum: 2, maximum: 5 },
          description: 'N-gram sizes to count. Default [2, 3, 4].',
        },
        min_count: {
          type: 'integer',
          minimum: 2,
          description: 'Minimum repetition count to report. Default 2.',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'How many top phrases to return. Default 25.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_similarity',
    keywords: ['similarity', 'duplicate', 'overlap', 'similar', 'match', 'compare', 'check', 'before', 'commit'],
    description:
      'Before adding or editing a character or beat, check whether a near-duplicate already exists. Returns the top similar items above a threshold (default 0.6) with which field matched and the similarity score. Two modes: (a) compare an existing item against the rest of the corpus by passing `target_type` + `identifier`; (b) compare a candidate text you are about to commit by passing `target_type` + `text`. Use mode (b) just before calling create_character or create_beat when the user describes someone or something that may overlap with what is already on file. Cosine similarity over stopword-filtered word counts. Note: the create/update handlers also run this check automatically and append a heads-up to their success message — this tool is for explicit before-the-fact checks.',
    input_schema: {
      type: 'object',
      properties: {
        target_type: {
          type: 'string',
          enum: ['character', 'beat'],
          description: 'Which corpus to compare against.',
        },
        identifier: {
          type: 'string',
          description: 'Existing character (name or _id) or beat (_id, order, or name) to compare. Mutually exclusive with `text`.',
        },
        text: {
          type: 'string',
          description: 'Raw candidate text (e.g., a draft desc + body, or a draft background_story). Use for "before I commit" checks. Mutually exclusive with `identifier`.',
        },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Minimum cosine score to report. Default 0.6.',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Cap on results returned. Default 5.',
        },
      },
      required: ['target_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_character_phrases',
    keywords: ['phrases', 'ngrams', 'words', 'theme', 'character', 'analysis', 'cloud', 'top'],
    description:
      'Concatenate every beat that lists this character and return the top n-grams across that combined text. Reveals what the character actually does in the story versus what their label says — if a "warrior" character\'s top trigrams are about doubt and conversation, the writing has drifted from the concept. Returns top phrases grouped by n-gram size, plus a count of beats featuring the character.',
    input_schema: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Character name (case-insensitive) or _id. Matches against beat.characters[].',
        },
        sizes: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 5 },
          description: 'N-gram sizes to compute. Default [1, 2, 3] (unigrams included for thematic word-cloud value).',
        },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['name', 'desc', 'body'] },
          description: 'Beat fields to concatenate. Default ["desc", "body"].',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many top phrases per size. Default 15.',
        },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'similar_character',
    keywords: ['similar', 'like', 'reminds', 'parallel', 'derivative', 'archetype', 'character', 'fictional', 'famous', 'homage'],
    description:
      'Detect resemblance between a character on file and well-known existing fictional characters from books, films, or TV. Builds a search query from the character\'s descriptive traits (background_story, origin_story, arc, events, memes, hollywood_actor) — the character\'s `name` is intentionally excluded so detection is "blind". Runs a Tavily web search, then has Claude analyze the results to identify candidate parallels. Use when the user asks "does this remind you of anyone famous?", "is my character derivative?", "did the homage land?", or proactively when traits seem to point at a known archetype. Returns Markdown with ranked parallels (work, character, confidence, evidence, source URL) or a "no strong parallels" message. Requires TAVILY_API_KEY.',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: "Character's name or _id." },
        focus: {
          type: 'string',
          description:
            'Optional bias term appended to the search query (e.g., "legal drama", "Russian literature"). Otherwise the query is built only from traits.',
        },
        max_works: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'How many top parallels to surface. Default 3.',
        },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    name: 'similar_works',
    keywords: ['similar', 'like', 'reminds', 'parallel', 'derivative', 'plot', 'works', 'films', 'books', 'movies', 'echoes'],
    description:
      'Detect resemblance between the screenplay\'s plot (or a single beat) and well-known existing works (books, films, TV). Builds a search query from the synopsis + beat outlines (or one beat\'s desc/body), runs a Tavily web search, then has Claude analyze the results for plot/structural parallels. Use when the user asks "does my plot remind you of anything?", "is this story derivative?", or "what works does this scene echo?". Returns Markdown with ranked parallels (work, parallel, confidence, evidence, source URL) or a "no strong parallels" message. Requires TAVILY_API_KEY.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['plot', 'beat'],
          description:
            "What to analyze. 'plot' (default) uses the synopsis + beat-outline summary. 'beat' uses a single beat's name/desc/body.",
        },
        beat: {
          type: 'string',
          description:
            'When scope is "beat", the beat _id, order, or name. Omit to use the current beat.',
        },
        focus: {
          type: 'string',
          description: 'Optional bias term appended to the search query (e.g., "heist films").',
        },
        max_works: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'How many top parallels to surface. Default 3.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_message_history',
    keywords: ['search', 'history', 'past', 'previous', 'earlier', 'recall', 'memory', 'conversation', 'channel', 'mentioned', 'remember'],
    description:
      "Search the channel's full message history (beyond the recent 60-message window already in your context) using a regex. Use when the operator asks you to recall something they mentioned earlier — names, descriptions, decisions — that isn't in your immediate history. CRAFT THE REGEX TO COVER ALTERNATE SPELLINGS, PLURALS, AND RELATED WORDS. Examples: for \"mustache\" use `must(?:a|ac)he?|moustache|stache|mustachio`; for \"the diner scene\" use `diner|coffee.?shop|caf[eé]|restaurant`. Default flag is case-insensitive. Use `since_days` and/or `until_days` for time windows (\"last week\" → since_days:7; \"about 2-3 weeks ago\" → since_days:21, until_days:7). Returns role/timestamp/excerpt/match for each hit, plus a `scan_limit_hit` flag warning that older messages weren't reached. Includes attachment filenames; skips image bytes and tool_use ids.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'JS regex pattern (no slashes/flags). Be liberal with alternation.',
        },
        flags: {
          type: 'string',
          description: 'Subset of "imsu". Default "i" (case-insensitive).',
        },
        since_days: {
          type: 'number',
          description: 'Only search the last N days. Omit for all history.',
        },
        until_days: {
          type: 'number',
          description: 'Skip the most recent N days. Combine with since_days for windows.',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'any'],
          description: 'Default "any".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max matches to return. Default 20.',
        },
        context_chars: {
          type: 'integer',
          minimum: 40,
          maximum: 500,
          description: 'Chars of context around each match. Default 200.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_dramatic_arc',
    keywords: ['arc', 'climax', 'pacing', 'structure', 'three-act', 'sentiment', 'analyze', 'dramatic', 'tension', 'narrative'],
    description:
      'Score each beat\'s sentiment and identify the climax — either the beat that deviates most from the baseline (max_deviation), or the beat with the steepest sentiment drop from the previous beat (steepest_drop). Reports the climax with its normalized position (0.0–1.0 by index in the ordered list); a healthy three-act climax sits around 0.75–0.90, so the response flags whether the detected position falls in that window. Use when the user asks "is my pacing right?", "where is the climax?", or "is the climax in the right place?". Requires at least 3 beats; returns no_signal if all beats have identical sentiment.',
    input_schema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['max_deviation', 'steepest_drop'],
          description: 'How to detect the climax. "max_deviation" picks the beat farthest from the corpus mean (positive or negative). "steepest_drop" picks the beat with the largest negative delta from its predecessor. Default "max_deviation".',
        },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['name', 'desc', 'body'] },
          description: 'Beat fields to score. Default ["desc", "body"].',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'calculator',
    keywords: ['calculate', 'compute', 'math', 'arithmetic', 'percent', 'percentage', 'evaluate', 'expression', 'number', 'sum', 'multiply', 'divide'],
    description: 'Evaluate a math expression with arbitrary-precision arithmetic — exact answers, no floating-point error. Supports +-*/, parentheses, exponentiation (^ or **), unary minus, sqrt, log/log10/log2, sin/cos/tan and inverses (radians by default; use deg suffix like 90deg for degrees), abs, floor/ceil/round, factorial (!), modulo (mod), constants (pi, e, tau). Use this whenever the user asks for arithmetic, percentages, conversions, big numbers (e.g. 2^200), or anything where 0.1+0.2 must equal 0.3 exactly. Returns JSON {expression, result} where result is a string formatted to the requested precision.',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The math expression to evaluate.' },
        precision: { type: 'integer', description: 'Significant digits in the formatted result. Default 14, range 4-64.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_code',
    keywords: ['run', 'execute', 'javascript', 'js', 'code', 'snippet', 'script', 'sandbox', 'algorithm', 'compute', 'transform'],
    description: 'Execute a self-contained SYNCHRONOUS JavaScript snippet in a sandbox and return its stdout, stderr, return value, and timing. Use for algorithmic problems beyond simple arithmetic — sorting, parsing, multi-step transforms, combinatorics, simulation, anything where you would otherwise compute by hand. The sandbox has language built-ins (Array, Math, JSON, Date, RegExp, Map, Set, Error, etc.) and console.{log,info,warn,error}. It does NOT have process, require, import, Buffer, fetch, setTimeout, setInterval, or any Node API — sync code only. Default timeout 5000ms (max 30000ms). Output capped at 8KB per stream. Print results with console.log; the value of the final expression is also returned.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source. Use console.log to emit results, or end with an expression whose value will be returned.' },
        timeout_ms: { type: 'integer', description: 'Wall-clock timeout in ms. Default 5000, min 50, max 30000.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'token_usage_report',
    keywords: ['tokens', 'usage', 'report', 'cost', 'consumption', 'budget', 'analytics', 'chart', 'leaderboard', 'metrics'],
    description: 'Show token consumption for a rolling time window. Returns three chart PNGs and a combined Markdown summary: (1) per-Discord-user stacked bar chart across three billed classes — Anthropic text, Anthropic image input, Gemini image gen; (2) per-tool token chart showing estimated tokens consumed by each tool\'s tool_result payloads (top 20 tools); (3) per-tool invocation count chart (top 20 tools). Use this to diagnose which tools are bloating context. Optionally filter by Discord display name (case-insensitive substring).',
    input_schema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          enum: ['day', 'week', 'month', 'total'],
          description: 'Rolling time window: day = last 24h, week = last 7d, month = last 30d, total = all-time.',
        },
        user: {
          type: 'string',
          description: 'Optional Discord display name to filter on. Omit for the full leaderboard.',
        },
      },
      required: ['window'],
      additionalProperties: false,
    },
  },
];

// Tools always present in the model's tools list, regardless of any
// tool_search calls. Keep this small — these are loaded on every iteration
// and contribute to per-call input tokens. Everything else is loaded lazily
// via the `tool_search` meta-tool.
export const CORE_TOOL_NAMES = new Set([
  'tool_search',
  'get_overview',
  'list_characters',
  'list_beats',
  'get_plot',
  'get_current_beat',
  'search_message_history',
]);

// Strip internal-only fields (`keywords`, `metaTool`) before sending to the
// Anthropic API. Returns API-shaped tool definitions for the given names, in
// the order they appear in TOOLS.
export function toolDefsForApi(names) {
  const set = names instanceof Set ? names : new Set(names || []);
  if (!set.size) return [];
  const out = [];
  for (const t of TOOLS) {
    if (!set.has(t.name)) continue;
    const { keywords, metaTool, ...api } = t;
    out.push(api);
  }
  return out;
}
