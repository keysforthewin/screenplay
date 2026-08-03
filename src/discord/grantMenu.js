// Project-grant select menu for the Discord approval flow.
//
// After a signup is approved (and the permission system is enabled), the bot
// follows up with a multi-select listing every project; whoever operates it
// sets the user's granted-project set to exactly the selection — same
// channel-wide trust model as the Approve/Deny buttons. Re-selecting on the
// same message re-adjusts (or revokes, via an empty selection) at any time.
//
// custom_id format:  perm:grant:<user _id hex>   (~35 chars, limit is 100)

import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { logger } from '../log.js';
import { getUserById, setUserProjects } from '../mongo/users.js';
import { listProjects } from '../mongo/projects.js';

export const GRANT_RE = /^perm:grant:([a-f0-9]{24})$/;

// Discord caps a select menu at 25 options and labels at 100 chars.
const MAX_OPTIONS = 25;
const MAX_LABEL = 100;

export function buildGrantComponents({ user, projects }) {
  if (projects.length > MAX_OPTIONS) {
    logger.warn(
      `grant menu: ${projects.length} projects exceed Discord's ${MAX_OPTIONS}-option cap — ` +
        'only the first 25 are selectable here; use the SPA Admin page for the rest',
    );
  }
  const granted = new Set((user.project_ids || []).map((id) => String(id).toLowerCase()));
  const options = projects.slice(0, MAX_OPTIONS).map((p) => ({
    label: String(p.title).slice(0, MAX_LABEL),
    value: p._id.toString(),
    default: granted.has(p._id.toString().toLowerCase()),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`perm:grant:${user._id.toString()}`)
    .setPlaceholder('Select projects (empty = no access)')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);
  return [new ActionRowBuilder().addComponents(menu)];
}

function grantContent(userName) {
  return (
    `Select the projects **${userName}** can access (multi-select; empty = none). ` +
    'Anyone here can set or change this at any time.'
  );
}

// Posted as a follow-up to the approval interaction (valid after
// ackResolution's interaction.update). A failure here must never break the
// approval itself — callers wrap in try/catch.
export async function postGrantMenu({ interaction, user }) {
  const projects = await listProjects();
  if (!projects.length) return;
  await interaction.followUp({
    content: grantContent(user.name),
    components: buildGrantComponents({ user, projects }),
  });
}

export async function handleGrantSelect(interaction) {
  const match = String(interaction.customId || '').match(GRANT_RE);
  if (!match) return;
  const user = await getUserById(match[1]);
  if (!user) {
    await interaction.reply({ content: 'Unknown user (account was removed?).', ephemeral: true });
    return;
  }
  // Filter against the live project list: a stale menu may still offer a
  // since-deleted project — drop it silently rather than failing the grant.
  const projects = await listProjects();
  const known = new Set(projects.map((p) => p._id.toString().toLowerCase()));
  const values = (interaction.values || []).filter((v) =>
    known.has(String(v).toLowerCase()),
  );
  const deciderTag = interaction.user?.tag || interaction.user?.username || 'unknown';
  const updated = await setUserProjects(user._id.toString(), values, { grantedBy: deciderTag });
  const titles = projects
    .filter((p) => updated.project_ids.includes(p._id.toString()))
    .map((p) => p.title);
  // Update in place with the new defaults so the same message stays a live,
  // re-adjustable control, and append a confirmation line.
  await interaction.update({
    content:
      `${grantContent(user.name)}\n` +
      `Current access: **${titles.join(', ') || 'none'}** — set by ${deciderTag}`,
    components: buildGrantComponents({ user: updated, projects }),
  });
}
