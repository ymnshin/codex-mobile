import { PermissionFlagsBits } from "discord.js";

const REQUIRED_DISCORD_PERMISSIONS = (
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.ManageThreads |
  PermissionFlagsBits.PinMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages
).toString();

export function buildDiscordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
    applicationId
  )}&scope=bot%20applications.commands&permissions=${REQUIRED_DISCORD_PERMISSIONS}&integration_type=0`;
}
