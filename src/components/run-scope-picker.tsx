"use client";

import { useState } from "react";

/** New Run scope control: pick groups (multi-select), an ad-hoc selection of
 *  dealers, or all sites — plus which missions the run executes (default: all). */
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
  const [checkedGroups, setCheckedGroups] = useState<Set<string>>(new Set());
  const [checkedSites, setCheckedSites] = useState<Set<string>>(new Set());
  const [checkedMissions, setCheckedMissions] = useState<Set<string>>(
    new Set(missions.map((m) => m.id))
  );

  const toggleMission = (id: string) => {
    setCheckedMissions((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setCheckedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSite = (id: string) => {
    setCheckedSites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="relative flex items-center gap-3">
      <input type="hidden" name="missionPickerShown" value="1" />

      {/* Mission checkboxes */}
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

      {/* Scope selector */}
      <select
        name="scope"
        value={scope}
        onChange={(e) => {
          setScope(e.target.value);
          setCheckedGroups(new Set());
          setCheckedSites(new Set());
        }}
        aria-label="Run scope"
        className="max-w-56 rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm"
      >
        <option value="">Scope: All sites</option>
        <option value="groups">Pick groups…</option>
        <option value="custom">Pick dealers…</option>
      </select>

      {/* Group picker panel */}
      {scope === "groups" && (
        <>
          <span className="text-xs text-zinc-500">
            {checkedGroups.size} group{checkedGroups.size !== 1 ? "s" : ""}
          </span>
          <div className="absolute right-0 top-full z-10 mt-2 max-h-80 w-64 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
            <p className="px-2 pb-2 pt-1 text-xs text-zinc-500">
              Check one or more groups — their sites are combined into one run.
            </p>
            {groups.map((group) => (
              <label
                key={group.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-zinc-900 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  name="groupIds"
                  value={group.id}
                  checked={checkedGroups.has(group.id)}
                  onChange={() => toggleGroup(group.id)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                {group.name}
              </label>
            ))}
          </div>
        </>
      )}

      {/* Dealer picker panel */}
      {scope === "custom" && (
        <>
          <span className="text-xs text-zinc-500">
            {checkedSites.size} selected
          </span>
          <div className="absolute right-0 top-full z-10 mt-2 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
            <p className="px-2 pb-2 pt-1 text-xs text-zinc-500">
              Check the dealers to collect in this one run — a throwaway group,
              nothing saved.
            </p>
            {sites.map((site) => (
              <label
                key={site.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-zinc-900 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  name="siteIds"
                  value={site.id}
                  checked={checkedSites.has(site.id)}
                  onChange={() => toggleSite(site.id)}
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
