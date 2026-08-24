# signalk-consumption-estimator

A Signal K server plugin that learns your freshwater tank consumption rate (liters/day) per crew count from the `communication.crewNames` roster, then publishes 24-hour predictions as Signal K deltas — estimated consumption (`consumption24h`, l/day), predicted remaining volume (`remaining24h`, l), and predicted tank level (`level24h`, ratio) — with units carried in path metadata, optional anomaly notifications when observed consumption runs well above the learned rate, and learned state persisted to the plugin data directory so it survives restarts.
