import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      [key: string]: any; // You can replace this with a specific type for your JWT payload structure
    };
  }
}