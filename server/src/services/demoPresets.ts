// Hardcoded demo campaigns the Demo view exposes via dropdown. Each preset
// carries (a) the plain-language prompt the agent will parse and (b) the
// vendor-specific triggers to fire entry events against SFMC. Personas are
// inferred by the agent from the prompt; the `personaAlias` on each trigger
// is used to match captured emails back to a specific SFMC contact.

import { CampaignTrigger } from '../types';

export type DemoCampaignKey = 'welcome';

export interface DemoPreset {
  key: DemoCampaignKey;
  label: string;
  tagline: string;
  prompt: string;
  triggers: CampaignTrigger[];
}

export const DEMO_PRESETS: Record<DemoCampaignKey, DemoPreset> = {
  welcome: {
    key: 'welcome',
    label: 'Welcome Campaign — Engagement check with timer',
    tagline: 'Two emails. Reminder fires only if the recipient does not click within 3 minutes.',
    prompt:
      'Welcome Campaign has two emails. Two test contacts are used: one with the alias +welcomeclicker and one with the alias +welcomenonclicker. The first email is sent to both contacts and contains a "Finish setup" CTA. If the recipient with the +welcomeclicker alias clicks the "Finish setup" CTA, nothing else happens. If the recipient with the +welcomenonclicker alias does not click within 3 minutes, send a reminder email with a "Verify email address" CTA.',
    triggers: [
      {
        vendor: 'sfmc',
        personaAlias: '+welcomeclicker',
        contactKey: 'DD302',
        email: 'sels+welcomeclicker@redpill-linpro.com',
        eventDefinitionKey: 'APIEvent-67412dd3-017b-8e6d-014d-3f3d850992f3',
        data: {
          SubscriberKey: 'DD302',
          Email: 'sels+welcomeclicker@redpill-linpro.com',
        },
      },
      {
        vendor: 'sfmc',
        personaAlias: '+welcomenonclicker',
        contactKey: 'DD303',
        email: 'sels+welcomenonclicker@redpill-linpro.com',
        eventDefinitionKey: 'APIEvent-67412dd3-017b-8e6d-014d-3f3d850992f3',
        data: {
          SubscriberKey: 'DD303',
          Email: 'sels+welcomenonclicker@redpill-linpro.com',
        },
      },
    ],
  },
};

export function isDemoCampaignKey(k: string): k is DemoCampaignKey {
  return k === 'welcome';
}
