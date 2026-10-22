export class BridgeError extends Error { constructor(public code:string,message:string,public recovery:string,public exitCode=2){super(message);this.name='BridgeError'} }
