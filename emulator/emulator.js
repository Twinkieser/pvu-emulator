/**
 * PVU (приточно-вытяжная установка) emulator.
 *
 * Simulates a supply/exhaust ventilation unit and publishes telemetry to
 * ThingsBoard over MQTT (v1/devices/me/telemetry). Values evolve over time
 * instead of being random: temperature drifts towards the setpoint with a
 * first-order lag, the filter gradually clogs, fans ramp up/down instead of
 * jumping, and alarms are derived from the simulated physical state.
 */

require('dotenv').config();
const mqtt = require('mqtt');

const TB_HOST = process.env.TB_HOST || 'localhost';
const TB_PORT = Number(process.env.TB_PORT || 1883);
const TB_DEVICE_TOKEN = process.env.TB_DEVICE_TOKEN;
const PUBLISH_INTERVAL_MS = Number(process.env.PUBLISH_INTERVAL_MS || 5000);
const TICK_MS = 1000; // internal simulation step; publish is a slower, separate cadence

if (!TB_DEVICE_TOKEN || TB_DEVICE_TOKEN === 'REPLACE_WITH_DEVICE_ACCESS_TOKEN') {
  console.error('Set TB_DEVICE_TOKEN in your .env file (device access token from ThingsBoard).');
  process.exit(1);
}

// ---------- helpers ----------

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const noise = (amplitude) => (Math.random() * 2 - 1) * amplitude;

// Exponential approach towards a target (first-order lag), roughly analogous
// to how air temperature responds to a heater/cooler over time.
function approach(current, target, ratePerTick) {
  return current + (target - current) * ratePerTick;
}

// ---------- simulated plant state ----------

const state = {
  // time bookkeeping
  simSeconds: 0,

  // operating mode
  running: true,
  alarm: false,
  filterClogged: false,

  // temperatures, °C
  outdoorTemp: -5 + noise(2),
  setpointTemp: 20,
  supplyTemp: 18,

  // actuators, %
  damperPosition: 100,
  heatingValve: 0,
  coolingValve: 0,

  // fans, % of nominal speed
  supplyFanSpeed: 0,
  exhaustFanSpeed: 0,

  // filter, Pa differential pressure
  filterPressureDrop: 40,

  // humidity, %
  humidity: 45,
};

let lastStopStartCheck = 0;
let lastFaultCheck = 0;

function simulateTick() {
  state.simSeconds += TICK_MS / 1000;

  // --- outdoor temperature: slow diurnal-like drift + noise ---
  const diurnal = 3 * Math.sin((2 * Math.PI * state.simSeconds) / (60 * 20)); // ~20 min "day" for demo purposes
  state.outdoorTemp = clamp(approach(state.outdoorTemp, -5 + diurnal, 0.01) + noise(0.05), -25, 15);

  // --- occasional operator actions: start/stop, setpoint change ---
  if (state.simSeconds - lastStopStartCheck > 90) {
    lastStopStartCheck = state.simSeconds;
    if (Math.random() < 0.08) {
      state.running = !state.running;
    }
    if (Math.random() < 0.15) {
      state.setpointTemp = clamp(state.setpointTemp + noise(1.5), 16, 24);
    }
  }

  // --- fans ramp towards target speed instead of jumping ---
  const targetFanSpeed = state.running ? 80 : 0;
  state.supplyFanSpeed = clamp(approach(state.supplyFanSpeed, targetFanSpeed, 0.08) + noise(0.5), 0, 100);
  state.exhaustFanSpeed = clamp(approach(state.exhaustFanSpeed, targetFanSpeed * 0.95, 0.08) + noise(0.5), 0, 100);

  // --- damper follows run status ---
  const targetDamper = state.running ? 100 : 0;
  state.damperPosition = clamp(approach(state.damperPosition, targetDamper, 0.1), 0, 100);

  // --- heating/cooling valves: simple proportional control on temp error ---
  const error = state.setpointTemp - state.supplyTemp;
  const deadband = 0.3;
  let targetHeating = 0;
  let targetCooling = 0;
  if (state.running) {
    if (error > deadband) targetHeating = clamp(error * 25, 0, 100);
    else if (error < -deadband) targetCooling = clamp(-error * 25, 0, 100);
  }
  state.heatingValve = clamp(approach(state.heatingValve, targetHeating, 0.15), 0, 100);
  state.coolingValve = clamp(approach(state.coolingValve, targetCooling, 0.15), 0, 100);

  // --- supply air temperature: pulled towards outdoor temp when off,
  //     towards setpoint (weighted by valve opening) when running ---
  if (state.running) {
    const heatEffect = (state.heatingValve / 100) * 6;   // max +6°C authority
    const coolEffect = (state.coolingValve / 100) * 6;   // max -6°C authority
    const mixTarget = state.outdoorTemp * 0.15 + state.setpointTemp * 0.85 + heatEffect - coolEffect;
    state.supplyTemp = approach(state.supplyTemp, mixTarget, 0.06) + noise(0.05);
  } else {
    state.supplyTemp = approach(state.supplyTemp, state.outdoorTemp, 0.01) + noise(0.05);
  }

  // --- filter fouling: pressure drop climbs slowly while running,
  //     occasionally "serviced" (reset) ---
  if (state.running) {
    state.filterPressureDrop += 0.03 + noise(0.01);
  }
  if (state.filterPressureDrop > 250 && Math.random() < 0.003) {
    // maintenance event: filter replaced
    state.filterPressureDrop = 35 + noise(3);
    state.filterClogged = false;
  }
  state.filterClogged = state.filterPressureDrop > 200;

  // --- humidity: bounded random walk ---
  state.humidity = clamp(state.humidity + noise(0.3), 25, 70);

  // --- fault / alarm simulation ---
  if (state.simSeconds - lastFaultCheck > 45) {
    lastFaultCheck = state.simSeconds;
    if (!state.alarm && Math.random() < 0.02) {
      state.alarm = true;
    } else if (state.alarm && Math.random() < 0.3) {
      state.alarm = false;
    }
  }
  // a badly clogged filter forces an alarm regardless of the random fault
  if (state.filterPressureDrop > 230) {
    state.alarm = true;
  }
}

function buildTelemetryPayload() {
  return {
    ts: Date.now(),
    values: {
      status: state.running ? 'running' : 'stopped',
      alarm: state.alarm,
      filterClogged: state.filterClogged,
      outdoorAirTemp: Number(state.outdoorTemp.toFixed(1)),
      supplyAirTemp: Number(state.supplyTemp.toFixed(1)),
      setpointTemp: Number(state.setpointTemp.toFixed(1)),
      supplyFanSpeed: Number(state.supplyFanSpeed.toFixed(0)),
      exhaustFanSpeed: Number(state.exhaustFanSpeed.toFixed(0)),
      damperPosition: Number(state.damperPosition.toFixed(0)),
      heatingValvePosition: Number(state.heatingValve.toFixed(0)),
      coolingValvePosition: Number(state.coolingValve.toFixed(0)),
      filterPressureDrop: Number(state.filterPressureDrop.toFixed(0)),
      humidity: Number(state.humidity.toFixed(0)),
    },
  };
}

// ---------- MQTT connection ----------

const client = mqtt.connect({
  host: TB_HOST,
  port: TB_PORT,
  username: TB_DEVICE_TOKEN, // ThingsBoard uses the device access token as MQTT username
});

client.on('connect', () => {
  console.log(`Connected to ThingsBoard MQTT broker at ${TB_HOST}:${TB_PORT}`);
  console.log(`Publishing telemetry every ${PUBLISH_INTERVAL_MS} ms`);

  setInterval(simulateTick, TICK_MS);

  setInterval(() => {
    const { ts, values } = buildTelemetryPayload();
    const payload = JSON.stringify({ ts, values });
    client.publish('v1/devices/me/telemetry', payload, { qos: 1 }, (err) => {
      if (err) console.error('Publish failed:', err.message);
    });
    console.log(`[${new Date(ts).toISOString()}]`, values);
  }, PUBLISH_INTERVAL_MS);
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
});

client.on('reconnect', () => {
  console.log('Reconnecting to ThingsBoard...');
});

process.on('SIGINT', () => {
  console.log('Shutting down emulator...');
  client.end(true, () => process.exit(0));
});
