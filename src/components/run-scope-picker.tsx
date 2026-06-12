"use client";

import { useState } from "react";

/** New Run scope control: a predefined run group or an ad-hoc selection of
 *  dealers (checkboxes, a temporary unsaved group), plus which missions the
 *  run executes (default: all). */
export function RunScopePicker({
  groups,
  sites,
  missions,
}: {
  groups: { id: string; name: string }[];
  sites: { id: string; name: string }[];
  missions: { id: string; name: string }[];
}) {
  const [scope, setScope] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [checkedMissions, setCheckedMissions] = useState<Set<string>>(
    new Set(missions.map((m) => m.id))
  );

  const toggleMission = (missionId: string) => {
    setCheckedMissions((prev) => {
      const next = new Set(prev);
      if (next.has(missionId)) next.delete(missionId);
      else next.add(missionId);
      return next;
    });
  };

  const toggle = (siteId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
  };

  return (
    <div className="relative flex items-center gap-3">
      <input type="hidden" name="missionPickerShown" value="1" />
      <div className="flex items-center gap-2.5 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5">
        {missions.map((mission) => (
          <label
            key={mission.id}
            className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-700"
          >
            <input
              type="checkbox"
              name="missionIds"
              value={mission.id}
              checked={checkedMissions.has(mission.id)}
              onChange={() => toggleMission(mission.id)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            {mission.name}
          </label>
        ))}
      </div>
      <select
        name="scope"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        className="max-w-56 rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm"
      >
        <option value="">All sites</option>
        <optgroup label="Run Groups">
          {groups.map((group) => (
            <option key={group.id} value={`group:${group.id}`}>
              {group.name}
            </option>
          ))}
        </optgroup>
        <option value="custom">Pick dealers…</option>
      </select>

      {scope === "custom" && (
        <>
          <span className="text-xs text-zinc-500">
            {checked.size} selected
          </span>
          <div className="absolute right-0 top-full z-10 mt-2 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
            {sites.map((site) => (
              <label
                key={site.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-zinc-900 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  name="siteIds"
                  value={site.id}
                  checked={checked.has(site.id)}
                  onChange={() => toggle(site.id)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                {site.name}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
