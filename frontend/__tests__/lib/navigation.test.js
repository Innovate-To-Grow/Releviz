import { navigateTo, reloadPage, replaceUrl } from "@/lib/navigation";

describe("browser navigation helpers", () => {
  test("navigates through the provided location object", () => {
    const locationObject = { assign: jest.fn() };

    navigateTo("/dashboard", locationObject);

    expect(locationObject.assign).toHaveBeenCalledWith("/dashboard");
  });

  test("reloads through the provided location object", () => {
    const locationObject = { reload: jest.fn() };

    reloadPage(locationObject);

    expect(locationObject.reload).toHaveBeenCalled();
  });

  test("replaces the current URL through the provided history object", () => {
    const historyObject = { replaceState: jest.fn() };

    replaceUrl("/event?code=EVENT123", historyObject);

    expect(historyObject.replaceState).toHaveBeenCalledWith({}, "", "/event?code=EVENT123");
  });
});
