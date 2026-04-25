export const TOOLS = [
  {
    name: 'get_overview',
    description: 'Single-call snapshot of EVERYTHING in the screenplay: synopsis + notes preview, every character (with casting, voice, fill ratio, image counts, one descriptive field preview), every beat (with name, full desc, body length, characters, image counts, current marker), and overall counts. Use this whenever the user asks for a summary, "show me everything", "what do we have", "what state is this in", "give me a rundown", "what beats need bodies", "which characters are missing images", or any other holistic question. Returns rich JSON; render it as markdown for Discord (the bot will auto-split long messages). Don\'t bombard the user with the entire payload — pick the angle that answers their question.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
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
    description: 'Return the current plot document (synopsis, beats, notes, current_beat_id).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_plot',
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
    description: 'Return a compact list of all beats with id, order, name, a short desc preview, body length, character count, image count, and whether each is the current beat. Sorted by order. For substring/fuzzy lookup across name+desc+body, use search_beats instead.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_beat',
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
    description: 'Return the current beat (full document) or null if none is set.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'clear_current_beat',
    description: 'Clear the current-beat pointer. After this, tools that default to the current beat will require an explicit identifier.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_beat_image',
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
    description: 'List unassigned (library) images — images that have been uploaded or generated but are not yet attached to any beat. Useful when the user says "save that image to the diner beat" and you need to find the image_id.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'attach_library_image_to_beat',
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
    name: 'show_image',
    description: 'Display an existing image (any image_id, whether attached to a beat or in the library) by attaching it to the bot\'s reply in Discord. Use when the user asks to "see" or "show" an image.',
    input_schema: {
      type: 'object',
      properties: { image_id: { type: 'string' } },
      required: ['image_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image with Google\'s "Nano Banana" (gemini-2.5-flash-image). The bot will display the generated image in its reply. ONLY call this when the user has explicitly asked for an image (e.g., "draw this", "generate an image of...", "show me what this looks like"). Compose the prompt from one or more of: an explicit `prompt` string, the current/named beat (set `include_beat: true`), or recent conversation context (set `include_recent_chat: true`). At least one of these inputs must be provided. If `attach_to_current_beat` is true (default when a current beat is set), the image is saved to that beat; otherwise it goes into the library and can be attached later via attach_library_image_to_beat. Returns the image_id and displays the image. Requires GEMINI_API_KEY to be configured.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Free-form prompt fragment to include verbatim.' },
        include_beat: { type: 'boolean', description: 'When true, weave the beat\'s name/desc/body/characters into the prompt.' },
        beat: { type: 'string', description: 'Identifier for the beat to draw from when include_beat is true. Defaults to the current beat.' },
        include_recent_chat: { type: 'boolean', description: 'When true, include a short summary of recent conversation in the prompt.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Optional aspect ratio. Defaults to 16:9.' },
        attach_to_current_beat: { type: 'boolean', description: 'Default true when a current beat is set; false otherwise. When false, the image lands in the library.' },
        set_as_main: { type: 'boolean' },
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
  {
    name: 'add_character_image',
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
    name: 'tmdb_search_movie',
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
];
