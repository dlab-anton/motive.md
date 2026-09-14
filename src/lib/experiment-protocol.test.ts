import { describe, expect, it } from 'vitest';
import { canonicalizeExperimentProtocol, ExperimentProtocolValidationError,
  experimentProtocolFingerprintPreimage, validateExperimentProtocol } from './experiment-protocol';

const protocol = () => ({ format: 'motive.experiment-protocol.v1' as const, procedure: 'bounded-search-v1',
  inputs: [{ name: 'seed', value: '17' }, { name: 'limit.seconds', value: '30' }], purpose: 'EXPLORATORY' as const });

describe('experiment protocol', () => {
  it('canonicalizes input order and excludes purpose from the fingerprint preimage', () => {
    const reversed = { ...protocol(), inputs: [...protocol().inputs].reverse(), purpose: 'REPLICATION' as const };
    expect(canonicalizeExperimentProtocol(reversed).inputs).toEqual(protocol().inputs.sort((a, b) => a.name.localeCompare(b.name)));
    const binding = { projectId: 'project', workOrderId: 'work', workOrderRevision: 1, workOrderTermsDigest: `sha256:${'a'.repeat(64)}` };
    expect(experimentProtocolFingerprintPreimage(binding, reversed))
      .toEqual(experimentProtocolFingerprintPreimage(binding, protocol()));
    expect(experimentProtocolFingerprintPreimage({ ...binding, workOrderRevision: 2 }, protocol()))
      .not.toEqual(experimentProtocolFingerprintPreimage(binding, protocol()));
    expect(experimentProtocolFingerprintPreimage({ ...binding, workOrderId: 'other-work' }, protocol()))
      .not.toEqual(experimentProtocolFingerprintPreimage(binding, protocol()));
  });

  it('preserves opaque values and accepts well-formed Unicode', () => {
    const value = { ...protocol(), procedure: 'search-🧪', inputs: [{ name: 'seed', value: '🌱 exact' }] };
    expect(validateExperimentProtocol(value)).toMatchObject(value);
  });

  it('retains the exact canonical bytes and accepted boundaries', () => {
    const boundary = { ...protocol(), procedure: 'p'.repeat(240), inputs: Array.from({ length: 32 }, (_, index) => ({
      name: index === 0 ? `a${'b'.repeat(63)}` : `v${index}`, value: index === 0 ? 'x'.repeat(512) : 'x' })) };
    const canonical = validateExperimentProtocol(boundary);
    expect(canonical).toEqual({ format:'motive.experiment-protocol.v1',procedure:boundary.procedure,
      inputs:[...boundary.inputs].sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0),purpose:'EXPLORATORY' });
    expect(JSON.stringify(validateExperimentProtocol(protocol()))).toBe(
      '{"format":"motive.experiment-protocol.v1","procedure":"bounded-search-v1","inputs":[{"name":"limit.seconds","value":"30"},{"name":"seed","value":"17"}],"purpose":"EXPLORATORY"}');
  });

  it('reports a safe indexed path and reason without echoing values or unknown fields', () => {
    const secret='private-value-must-not-echo';
    try { validateExperimentProtocol({ ...protocol(),inputs:[{ name:'camelCase',value:secret }] });
      throw new Error('Expected validation to fail.');
    } catch(error) {
      expect(error).toBeInstanceOf(ExperimentProtocolValidationError);
      expect(error).toMatchObject({path:'experimentProtocol.inputs[0].name'});
      expect((error as Error).message).toBe('Invalid experiment protocol. experimentProtocol.inputs[0].name must start with a lowercase letter and contain only lowercase letters, digits, underscore, dot, or hyphen, with at most 64 characters.');
      expect((error as Error).message).not.toContain(secret);
    }
    const unknown='unknownSecretField';
    expect(() => validateExperimentProtocol({ ...protocol(),inputs:[{name:'seed',value:secret,[unknown]:'hidden'}] }))
      .toThrow('Invalid experiment protocol. experimentProtocol.inputs[0] must contain exactly name and value.');
    try { validateExperimentProtocol({ ...protocol(),inputs:[{name:'seed',value:secret,[unknown]:'hidden'}] }); }
    catch(error) { expect((error as Error).message).not.toContain(unknown);expect((error as Error).message).not.toContain(secret); }
  });

  it('distinguishes duplicate and boundary failures without changing acceptance', () => {
    const cases: Array<[unknown,string,string]> = [
      [{ ...protocol(),procedure:'p'.repeat(241) },'experimentProtocol.procedure','at most 240 characters'],
      [{ ...protocol(),inputs:[{name:`a${'b'.repeat(64)}`,value:'x'}] },'experimentProtocol.inputs[0].name','at most 64 characters'],
      [{ ...protocol(),inputs:[{name:'seed',value:'x'.repeat(513)}] },'experimentProtocol.inputs[0].value','at most 512 characters'],
      [{ ...protocol(),inputs:[{name:'seed',value:'1'},{name:'seed',value:'2'}] },'experimentProtocol.inputs[1].name','must be unique'],
      [{ ...protocol(),inputs:Array.from({length:33},(_,index)=>({name:`v${index}`,value:'x'})) },
        'experimentProtocol.inputs','between 1 and 32 items'],
    ];
    for(const [value,path,reason] of cases){try{validateExperimentProtocol(value);throw new Error('Expected validation to fail.');}
      catch(error){expect(error).toBeInstanceOf(ExperimentProtocolValidationError);
        expect(error).toMatchObject({path});expect((error as Error).message).toContain(reason);}}
  });

  it.each([
    null, { ...protocol(), extra: true }, { ...protocol(), procedure: ' padded ' },
    { ...protocol(), procedure: '\ud800' }, { ...protocol(), inputs: [] },
    { ...protocol(), inputs: [{ name: 'Seed', value: '1' }] },
    { ...protocol(), inputs: [{ name: 'seed', value: ' 1' }] },
    { ...protocol(), inputs: [{ name: 'seed', value: '1' }, { name: 'seed', value: '2' }] },
    { ...protocol(), inputs: Array.from({ length: 33 }, (_, index) => ({ name: `v${index}`, value: 'x' })) },
    { ...protocol(), inputs: [{ name: 'seed', value: 'x'.repeat(513) }] },
    { ...protocol(), inputs: Array.from({ length: 8 }, (_, index) => ({ name: `v${index}`, value: 'x'.repeat(512) })) },
    { ...protocol(), inputs: [{ name: 'seed', value: '\u00a01' }] },
    { ...protocol(), inputs: [{ name: 'seed', value: '1\u2028part' }] },
  ])('rejects malformed protocols %#', value => {
    expect(() => validateExperimentProtocol(value)).toThrow('Invalid experiment protocol.');
  });
});
