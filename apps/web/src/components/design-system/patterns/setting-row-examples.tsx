'use client';

import * as React from 'react';

import { SETTING_LIST_CLASS, SettingRow } from '@/components/settings/setting-row';

/**
 * The single-row examples of the settings section on /design-system: one per
 * kind of numeric or list control `SettingRow` picks by itself. Kept apart
 * from `rows.tsx`, which holds the sections around them.
 */

export function ByteRowExample() {
  const [bytes, setBytes] = React.useState(10 * 1_024 * 1_024);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="ai.pdfMaxBytes"
          value={bytes}
          onChange={(value) => {
            if (typeof value === 'number') setBytes(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}

export function HostListRowExample() {
  const stored = 'hooks.example.org, n8n.example.net';
  const [hosts, setHosts] = React.useState(`${stored}, *.example.com, api.hooks.example.org`);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="automations.webhookAllowedHosts"
          value={hosts}
          stored={stored}
          onChange={(value) => {
            if (typeof value === 'string') setHosts(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}

export function ContainerImageRowExample() {
  const stored = 'exocortex-render:latest';
  const [image, setImage] = React.useState(stored);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="projects.image"
          value={image}
          stored={stored}
          onChange={(value) => {
            if (typeof value === 'string') setImage(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}

export function ZeroMeansRowExample() {
  const [journal, setJournal] = React.useState(90);
  const [payloads, setPayloads] = React.useState(0);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="agents.journalRetentionDays"
          value={journal}
          onChange={(value) => {
            if (typeof value === 'number') setJournal(value);
          }}
          models={[]}
        />
      </div>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="ai.runPayloadRetentionDays"
          value={payloads}
          onChange={(value) => {
            if (typeof value === 'number') setPayloads(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}

export function MoneyRowExample() {
  const [budget, setBudget] = React.useState(2_000_000);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="workflows.budgetMicroUsdPerRun"
          value={budget}
          onChange={(value) => {
            if (typeof value === 'number') setBudget(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}

export function DurationRowExample() {
  const [lifetime, setLifetime] = React.useState(7 * 24 * 3_600);
  const [hour, setHour] = React.useState(7);
  return (
    <div className={SETTING_LIST_CLASS}>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="workflows.maxLifetimeSeconds"
          value={lifetime}
          onChange={(value) => {
            if (typeof value === 'number') setLifetime(value);
          }}
          models={[]}
        />
      </div>
      <div className="max-sm:py-4">
        <SettingRow
          settingKey="notifications.digestHour"
          value={hour}
          onChange={(value) => {
            if (typeof value === 'number') setHour(value);
          }}
          models={[]}
        />
      </div>
    </div>
  );
}
