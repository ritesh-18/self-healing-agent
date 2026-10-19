import type { ClinicState, Patient } from "../clinic/state.js";
import type { EventBus } from "../events/bus.js";

/**
 * Identity and registration.
 *
 * Name plus mobile is a LOOKUP KEY, not proof of identity - both are things a
 * stranger can know. Verification requires a second factor the caller must
 * supply, and until it passes, nothing about the patient is read or disclosed.
 *
 * Three rules here are easy to get wrong and each has a specific failure
 * behind it:
 *
 *  - Attempts are capped. Unlimited retries turn the phone line into a
 *    brute-force oracle for a date of birth.
 *  - Near matches are never offered. "Did you mean Radhika Nair?" confirms
 *    that a person is a patient to someone who just failed verification.
 *  - Existence is neither confirmed nor denied before verification succeeds.
 */

export const MAX_VERIFICATION_ATTEMPTS = 3;

export type IdentityStatus =
  | "unidentified"
  | "verified"
  | "locked"
  | "unregistered";

export interface IdentityResult {
  status: IdentityStatus;
  patientId?: string;
  attemptsRemaining: number;
  message: string;
}

export interface RegistrationDraft {
  name?: string;
  mobile?: string;
  email?: string;
  dob?: string;
  address?: string;
  reason?: string;
}

/** Fields a new patient must supply before a record is created. */
const REQUIRED_FIELDS: (keyof RegistrationDraft)[] = [
  "name",
  "mobile",
  "dob",
];

export class IdentityService {
  private attempts = 0;
  private status: IdentityStatus = "unidentified";
  private patientId: string | null = null;
  private draft: RegistrationDraft = {};

  constructor(
    private readonly state: ClinicState,
    private readonly bus: EventBus,
  ) {}

  get verifiedPatientId(): string | null {
    return this.status === "verified" ? this.patientId : null;
  }

  get currentStatus(): IdentityStatus {
    return this.status;
  }

  /**
   * Accepts a verification performed by the tool layer.
   *
   * `lookup_patient` does its own matching, so without this the orchestrator
   * keeps a stale null and the write gate refuses every booking as
   * unverified. A locked caller stays locked: the attempt cap must not be
   * bypassable by routing through the tool.
   */
  adoptVerified(patientId: string): boolean {
    if (this.status === "locked") return false;

    this.status = "verified";
    this.patientId = patientId;
    this.bus.emit("identity.verified", { patientId, viaTool: true });
    return true;
  }

  /**
   * Verifies a caller by name plus date of birth.
   *
   * Mobile narrows the lookup but never substitutes for the second factor:
   * a caller who knows a name and number still has to know the DOB.
   */
  verify(name: string, dob: string, mobile?: string): IdentityResult {
    if (this.status === "locked") {
      return {
        status: "locked",
        attemptsRemaining: 0,
        message:
          "Too many failed attempts on this call. A staff member will need " +
          "to help.",
      };
    }

    this.attempts++;
    this.bus.emit("identity.attempted", { attempt: this.attempts });

    const match = this.lookup(name, dob, mobile);

    if (match) {
      this.status = "verified";
      this.patientId = match.id;
      this.bus.emit("identity.verified", {
        patientId: match.id,
        attempts: this.attempts,
      });
      return {
        status: "verified",
        patientId: match.id,
        attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - this.attempts,
        message: "Verified.",
      };
    }

    const remaining = MAX_VERIFICATION_ATTEMPTS - this.attempts;
    this.bus.emit("identity.failed", {
      attempt: this.attempts,
      remaining,
    });

    if (remaining <= 0) {
      this.status = "locked";
      this.bus.emit("identity.locked", { attempts: this.attempts });
      return {
        status: "locked",
        attemptsRemaining: 0,
        message:
          "I could not confirm those details. Let me pass you to a staff " +
          "member who can help.",
      };
    }

    return {
      status: "unidentified",
      attemptsRemaining: remaining,
      // Deliberately says nothing about whether the name exists on file.
      message:
        "Those details do not match our records. Could you confirm your " +
        "full name and date of birth for me?",
    };
  }

  /** Exact match on both factors. No fuzzy matching, by design. */
  private lookup(
    name: string,
    dob: string,
    mobile?: string,
  ): Patient | undefined {
    const needle = name.trim().toLowerCase();
    return this.state.patients.find(
      (p) =>
        p.name.toLowerCase() === needle &&
        p.dob === dob &&
        (!mobile || p.phone === mobile.trim()),
    );
  }

  // --- Registration -------------------------------------------------------

  startRegistration(): void {
    this.status = "unregistered";
    this.bus.emit("registration.started", {});
  }

  /** Accumulates details across turns; a caller volunteers them piecemeal. */
  collect(fields: RegistrationDraft): {
    complete: boolean;
    missing: (keyof RegistrationDraft)[];
  } {
    this.draft = { ...this.draft, ...fields };
    const missing = REQUIRED_FIELDS.filter((f) => !this.draft[f]);
    return { complete: missing.length === 0, missing };
  }

  get registrationDraft(): RegistrationDraft {
    return { ...this.draft };
  }

  /**
   * Creates the patient record and verifies them for this call.
   *
   * The reason for calling is captured as ROUTING data, not clinical data -
   * "chest pain" in a reason field still has to trip the safety screen.
   */
  completeRegistration(): IdentityResult {
    const missing = REQUIRED_FIELDS.filter((f) => !this.draft[f]);
    if (missing.length > 0) {
      return {
        status: "unregistered",
        attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - this.attempts,
        message: `Still need: ${missing.join(", ")}.`,
      };
    }

    const patient: Patient = {
      id: `p${this.state.patients.length + 1}`,
      name: this.draft.name!,
      dob: this.draft.dob!,
      phone: this.draft.mobile!,
    };
    this.state.patients.push(patient);

    this.status = "verified";
    this.patientId = patient.id;
    this.bus.emit("registration.completed", { patientId: patient.id });
    this.bus.emit("identity.verified", {
      patientId: patient.id,
      viaRegistration: true,
    });

    return {
      status: "verified",
      patientId: patient.id,
      attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - this.attempts,
      message: "Registered and verified.",
    };
  }
}
