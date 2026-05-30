import { IEngine, CompletionResult } from './IEngine';
import { StateMachine } from '../state/stateMachine';

export class EngineRouter {
    private readonly engines: IEngine[];
    private readonly stateMachine: StateMachine;

    constructor(engines: IEngine[], stateMachine: StateMachine) {
        this.engines = engines;
        this.stateMachine = stateMachine;
    }

    /**
     * Executes the fallback routing logic sequentially through configured engines.
     */
    public async execute(prompt: string): Promise<CompletionResult> {
        const state = this.stateMachine.readState();
        const now = Date.now();

        for (const engine of this.engines) {
            const breaker = state.circuitBreakers[engine.name];
            
            // Check if this engine's circuit breaker is currently tripped
            if (breaker && breaker.tripsAt > now) {
                console.warn(`Engine "${engine.name}" is currently blocked by circuit breaker until ${new Date(breaker.tripsAt).toISOString()}`);
                continue;
            }

            try {
                // Attempt completion
                const response = await engine.complete(prompt);

                // Success path: update active engine and persist state
                state.activeEngine = engine.name;
                state.status = 'IDLE'; // Ensure status is set to IDLE on successful completion
                this.stateMachine.writeState(state);
                return response;
            } catch (error) {
                console.error(`Engine "${engine.name}" failed:`, error);

                // Trip the circuit breaker for 15 minutes
                const cooldownMs = 15 * 60 * 1000;
                state.circuitBreakers[engine.name] = {
                    tripsAt: Date.now() + cooldownMs,
                    cooldownMs: cooldownMs
                };
                this.stateMachine.writeState(state);
            }
        }

        throw new Error('All engines exhausted. Circuit breakers tripped.');
    }

    /**
     * Executes the fallback routing logic sequentially, using system instructions and no history.
     */
    public async executeWithSystemInstruction(systemInstruction: string, prompt: string): Promise<CompletionResult> {
        const state = this.stateMachine.readState();
        const now = Date.now();

        for (const engine of this.engines) {
            const breaker = state.circuitBreakers[engine.name];
            
            if (breaker && breaker.tripsAt > now) {
                console.warn(`Engine "${engine.name}" is currently blocked by circuit breaker until ${new Date(breaker.tripsAt).toISOString()}`);
                continue;
            }

            try {
                // Attempt completion with history (empty history array)
                const response = await engine.completeWithHistory(systemInstruction, [], prompt, false);

                state.activeEngine = engine.name;
                state.status = 'IDLE'; 
                this.stateMachine.writeState(state);
                return response;
            } catch (error) {
                console.error(`Engine "${engine.name}" failed:`, error);

                // Trip the circuit breaker for 15 minutes
                const cooldownMs = 15 * 60 * 1000;
                state.circuitBreakers[engine.name] = {
                    tripsAt: Date.now() + cooldownMs,
                    cooldownMs: cooldownMs
                };
                
                // Save updated state before attempting fallback
                this.stateMachine.writeState(state);
            }
        }

        // If loop completes, all engines failed or were blocked
        state.status = 'ERROR';
        this.stateMachine.writeState(state);
        throw new Error('All routing engines failed.');
    }
}
