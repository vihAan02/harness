-- Presence (D-75). A heartbeat updates devices.last_heartbeat_at and logs nothing. Only a change in a
-- device's presence in a project becomes an event (device.online / device.offline), so the event
-- log doesn't fill with one row per device every few seconds.
CREATE TABLE device_presence (
  project_id text NOT NULL REFERENCES projects (id),
  device_id  text NOT NULL REFERENCES devices (id),
  online     boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, device_id)
);
