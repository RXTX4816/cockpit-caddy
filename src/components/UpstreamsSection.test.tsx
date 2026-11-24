import { describe, it, expect } from "vitest";
import { emptyLbArgs, lbArgsFromValues, lbArgsToValues, validateLbArgs } from "./UpstreamsSection";

describe("load-balancing policy arguments (#285)", () => {
  const args = (patch: Partial<ReturnType<typeof emptyLbArgs>>) => ({ ...emptyLbArgs(), ...patch });

  it("weighted_round_robin needs one whole-number weight per upstream", () => {
    expect(validateLbArgs("weighted_round_robin", args({ weights: ["3", "1"] }), 2)).toBeNull();
    expect(validateLbArgs("weighted_round_robin", args({ weights: ["3"] }), 2)).toBe("upstreams.validation_weights");
    expect(validateLbArgs("weighted_round_robin", args({ weights: ["3", "1", "1"] }), 2)).toBe("upstreams.validation_weights");
    expect(validateLbArgs("weighted_round_robin", args({ weights: ["3", ""] }), 2)).toBe("upstreams.validation_weights");
    expect(validateLbArgs("weighted_round_robin", args({ weights: ["3", "x"] }), 2)).toBe("upstreams.validation_weights");
  });

  it("header needs a field; random_choose a count of at least 1", () => {
    expect(validateLbArgs("header", args({}), 2)).toBe("upstreams.validation_header");
    expect(validateLbArgs("header", args({ headerField: "X-User" }), 2)).toBeNull();
    expect(validateLbArgs("random_choose", args({ choose: "0" }), 2)).toBe("upstreams.validation_choose");
    expect(validateLbArgs("random_choose", args({ choose: "" }), 2)).toBeNull();
  });

  it("keeps only the arguments of the chosen policy", () => {
    const v = args({ headerField: "X-A", cookieName: "sid", weights: ["1", "2"], choose: "3" });
    expect(lbArgsFromValues("cookie", v)).toEqual({ cookieName: "sid" });
    expect(lbArgsFromValues("weighted_round_robin", v)).toEqual({ weights: [1, 2] });
    expect(lbArgsFromValues("round_robin", v)).toBeUndefined();
    expect(lbArgsToValues({ weights: [2, 5], chooseCount: 4 })).toEqual(args({ weights: ["2", "5"], choose: "4" }));
  });
});
