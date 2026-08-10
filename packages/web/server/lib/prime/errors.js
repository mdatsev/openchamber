export class PrimeServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PrimeServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
