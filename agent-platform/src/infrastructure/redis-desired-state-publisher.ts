import type { DesiredStateEvent, DesiredStatePublisher } from "../domain/contracts";

export interface RedisPublisherClient {
    publish(channel: string, message: string): Promise<number>;
}

export class RedisDesiredStatePublisher implements DesiredStatePublisher {
    constructor(
        private readonly client: RedisPublisherClient,
        private readonly channel = "agent-platform:desired-state",
    ) {}

    async publish(event: DesiredStateEvent): Promise<void> {
        await this.client.publish(this.channel, JSON.stringify(event));
    }
}
