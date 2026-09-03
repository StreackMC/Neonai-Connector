/**
 * @abstract Extend me plz
 * @internalApi For Neonai Connector only
 */
export class NeonaicNewable {
  #INSTANCE_ID = new UUID();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };

  constructor() {
    if (new.target === NeonaicNewable) throw new Error("NeonaicNewable is a raw class, which is not allowed to be create directly");
    
  }
}