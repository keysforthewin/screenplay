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
  {
    name: 'find_repeated_phrases',
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
];
